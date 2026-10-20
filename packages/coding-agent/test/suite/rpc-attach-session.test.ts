import { expect, it } from "vitest";
import { attachmentRig } from "./rpc-attachment-support.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";

// senpi#3795: unlike open-by-path, a transient attach never creates a session or changes its profile.
it.each(["in-process", "worker"] as const)(
	"attaches only the selected live identity on a %s socket host",
	async (sessionRuntime) => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const owner = await host.connect();
			const caller = await host.connect();
			const opened = await owner.request({ type: "open_session", cwd: host.cwd, permissionPreset: "full-access" });
			expect(opened.success).toBe(true);
			const sessionId = opened.data?.sessionId;
			const durableSessionId = opened.data?.state?.sessionId;
			const protocol = await caller.request({ type: "get_protocol_info" });
			expect(protocol.data?.capabilities).toEqual(
				expect.arrayContaining(["attach_session", "release_attachment", "release_caller_aware", "reclaim_session"]),
			);
			expect(
				await caller.request({ type: "attach_session", sessionId, durableSessionId: "recycled" }),
			).toMatchObject({
				success: false,
				error: "session_identity_mismatch",
			});
			expect(
				await caller.request({
					type: "attach_session",
					sessionId,
					durableSessionId,
					expectedHostInstance: "old-host",
				}),
			).toMatchObject({ success: false, error: "session_identity_mismatch" });
			expect(await caller.request({ type: "attach_session", sessionId, durableSessionId })).toMatchObject({
				success: true,
				data: { sessionId },
			});
			expect((await caller.request({ type: "list_sessions" })).data?.sessions).toEqual([
				expect.objectContaining({ sessionId, attachments: 2 }),
			]);
			await caller.request({ type: "release_attachment", sessionId });
			await owner.request({ type: "close_session", sessionId });
			expect(await caller.request({ type: "attach_session", sessionId, durableSessionId })).toMatchObject({
				success: false,
				error: "unknown_session",
			});
			expect((await caller.request({ type: "list_sessions" })).data?.sessions).toEqual([]);
		} finally {
			await host.dispose();
		}
	},
	60_000,
);

it("preserves every launch profile field and publishes an attach", async () => {
	await using rig = await attachmentRig();
	const ref = await rig.session();
	const entry = rig.registry.peek(ref.sessionId);
	if (!entry) throw new Error("Missing opened entry");
	const before = entry.profile;
	const status = await rig.send("observer", { id: "sub", type: "subscribe_sessions" });
	expect(status).toMatchObject({ success: true });
	expect(await rig.send("temporary", { id: "attach", type: "attach_session", ...ref })).toMatchObject({
		success: true,
	});
	expect(entry.profile).toBe(before);
	expect(rig.recordsFor("observer")).toContainEqual(
		expect.objectContaining({
			type: "session_status",
			lastChange: expect.objectContaining({ cause: "attach" }),
		}),
	);
});
