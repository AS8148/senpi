/**
 * `move_session` lock scope (senpi#3678 delta review LOW 1 and LOW 2): `finish` refuses a session another process
 * holds, and the "open on this host" check runs inside the move lock.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { holdSessionFile } from "../../src/core/session-holders.ts";
import { realSessionPath } from "../../src/core/session-move/session-lock.ts";
import { serializeByKey } from "../../src/core/session-sidecar-store.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { customTypes, devices, hostAndRelease, move } from "./rpc-move-session-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const declined = { state: "declined", reason: "cancelled" };

const admitted = (file: string, text: string) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(
			(line) => line.includes('"pending_input_transition"') && line.includes('"admitted"') && line.includes(text),
		).length;

async function exported(moveId: string) {
	const fixture = await devices();
	const rig = createInProcessRig(fixture.agentA);
	await hostAndRelease(rig, fixture.repoA, fixture.sessionPath, moveId);
	await move(rig, {
		op: "export",
		sessionPath: fixture.sessionPath,
		moveId,
		target: "device-b",
		droppedUserMessages: ["q1"],
	});
	return { ...fixture, rig };
}

describe("move_session lock scope (senpi#3678)", () => {
	it("#given another process holds the session #when finish runs #then it refuses session_held and re-queues nothing", async () => {
		const { rig, sessionPath } = await exported("move-8");
		await using a = rig;
		const otherGeneration = holdSessionFile(sessionPath, SESSION_ID, { expectExisting: true });

		const refused = await move(a, { op: "finish", sessionPath, moveId: "move-8", answer: declined });
		otherGeneration.release();

		expect(refused).toMatchObject({ success: false, error: "session_held" });
		expect(customTypes(sessionPath)).toEqual(["session_released"]);
		expect(admitted(sessionPath, "q1")).toBe(0);
		expect(await move(a, { op: "finish", sessionPath, moveId: "move-8", answer: declined })).toMatchObject({
			success: true,
			data: { ownership: "writable" },
		});
		expect(admitted(sessionPath, "q1")).toBe(1);
	});

	it("#given the session opens here while finish waits for the move lock #then finish refuses session_open_here", async () => {
		const { rig, repoA, sessionPath } = await exported("move-9");
		await using a = rig;
		let unblock = (): void => {};
		const blocker = serializeByKey(
			`session-move:${realSessionPath(sessionPath)}`,
			() =>
				new Promise<void>((resolve) => {
					unblock = resolve;
				}),
		);

		const finishing = move(a, { op: "finish", sessionPath, moveId: "move-9", answer: declined });
		opened(await a.open("conn-b", { cwd: repoA, sessionPath, retain_on_disconnect: true }), 0);
		unblock();
		await blocker;

		expect(await finishing).toMatchObject({ success: false, error: "session_open_here" });
		expect(customTypes(sessionPath)).toEqual(["session_released"]);
		expect(admitted(sessionPath, "q1")).toBe(0);
	});
});
