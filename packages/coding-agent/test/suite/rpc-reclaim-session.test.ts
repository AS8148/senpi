import { expect, it } from "vitest";
import { attachmentRig } from "./rpc-attachment-support.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// senpi#3795: reclaim is one synchronous attach-and-claim, never an abort followed by a racy close.
it.each([0, 1, 3])("claims all %i pre-existing caller holds before teardown awaits", async (holds) => {
	await using rig = await attachmentRig();
	const ref = await rig.session(holds);
	const entry = rig.registry.peek(ref.sessionId);
	const turn = rig.turns.get(ref.sessionPath);
	if (!entry || !turn) throw new Error("Missing live session");
	turn.start();
	rig.teardown.hold();
	const reclaim = rig.send(holds === 0 ? "recovery" : "caller", { id: "reclaim", type: "reclaim_session", ...ref });
	try {
		expect(entry.state).toBe("closing");
		expect(entry.attachments).toBeLessThanOrEqual(0);
		const competing = await rig.send("competitor", { id: "late-attach", type: "attach_session", ...ref });
		expect(competing).toMatchObject({ success: false });
	} finally {
		rig.teardown.release();
		await reclaim;
	}
	expect(await reclaim).toMatchObject({ success: true });
	expect(turn.aborted).toBe(true);
	expect(await rig.list()).toEqual([]);
});

it("refuses attached_elsewhere, including an attach begun concurrently before reclaim", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const attach = rig.send("other", { id: "other", type: "attach_session", ...ref });
	const reclaim = rig.send("caller", { id: "reclaim", type: "reclaim_session", ...ref });
	expect(await attach).toMatchObject({ success: true });
	expect(await reclaim).toMatchObject({
		success: false,
		error: "attached_elsewhere",
		errorData: { attachments: 1 },
	});
	expect(await rig.list()).toContainEqual(
		expect.objectContaining({ sessionId: ref.sessionId, attachments: 2, status: "open" }),
	);
});

it.each(["durableSessionId", "expectedHostInstance"] as const)(
	"refuses a mismatching or missing %s without touching the session",
	async (field) => {
		await using rig = await attachmentRig();
		const ref = await rig.session();
		for (const value of ["stale", undefined]) {
			expect(
				await rig.send("caller", {
					id: `mismatch-${value}`,
					type: "reclaim_session",
					...ref,
					[field]: value,
				}),
			).toMatchObject({ success: false, error: "session_identity_mismatch" });
		}
		expect(await rig.list()).toContainEqual(expect.objectContaining({ attachments: 1, status: "open" }));
	},
);

it.each(["opening", "closing"] as const)("refuses a %s target without claiming its holds", async (state) => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const entry = rig.registry.peek(ref.sessionId);
	if (!entry) throw new Error("Missing entry");
	entry.state = state;
	try {
		expect(await rig.send("caller", { id: "busy", type: "reclaim_session", ...ref })).toMatchObject({
			success: false,
			error: "session_busy_lifecycle",
		});
		expect(entry.attachments).toBe(1);
	} finally {
		entry.state = "open";
	}
});

it("never opens or resumes a vanished path", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	await rig.close("caller", ref.sessionId);
	expect(await rig.send("caller", { id: "gone", type: "reclaim_session", ...ref })).toMatchObject({
		success: false,
		error: "unknown_session",
	});
	expect(await rig.list()).toEqual([]);
});

it.each(["in-process", "worker"] as const)(
	"reclaims zero, one and several holds through a real %s socket",
	async (sessionRuntime) => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const caller = await host.connect();
			const protocol = await caller.request({ type: "get_protocol_info" });
			for (const holds of [0, 1, 3]) {
				const opened = await caller.request({ type: "open_session", cwd: host.cwd, retain_on_disconnect: true });
				expect(opened.success).toBe(true);
				const ref = {
					sessionId: opened.data?.sessionId,
					sessionPath: opened.data?.state?.sessionFile,
					durableSessionId: opened.data?.state?.sessionId,
					expectedHostInstance: protocol.data?.instanceId,
				};
				for (let index = 1; index < holds; index++)
					expect(await caller.request({ type: "attach_session", ...ref })).toMatchObject({ success: true });
				if (holds === 0)
					expect(await caller.request({ type: "release_attachment", sessionId: ref.sessionId })).toMatchObject({
						success: true,
					});
				expect(await caller.request({ type: "reclaim_session", ...ref })).toMatchObject({ success: true });
				expect((await caller.request({ type: "list_sessions" })).data?.sessions).toEqual([]);
			}
		} finally {
			await host.dispose();
		}
	},
	90_000,
);
