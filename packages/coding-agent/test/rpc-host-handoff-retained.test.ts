import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { readHostStatus } from "../src/modes/rpc/host-status.ts";
import { signalGeneration } from "../src/modes/rpc/host-stop.ts";
import {
	type GenerationScratch,
	type HeldAnthropicModel,
	type JsonlPeer,
	reapProcessesUnder,
	waitForPidGone,
} from "./helpers/rpc-generation-support.ts";
import { beginHandoverCommand, connect, dataOf, startHandoverRig } from "./helpers/rpc-idle-handover-support.ts";

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const models: HeldAnthropicModel[] = [];
const pids: number[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const model of models.splice(0)) {
		model.release();
		await model.close();
	}
	for (const pid of pids.splice(0)) if (signalGeneration(pid, "SIGKILL")) await waitForPidGone(pid, 20_000);
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

/**
 * senpi#3276: a retained idle session must survive a generation handoff. The host parks it with
 * reason `handoff_parked` and tells the owning connection the path to reopen by; the successor (or
 * the client acting on the park) reopens it with the SAME durable session id. Before the fix the
 * successor came up with zero retained sessions and the lane vanished.
 */
describe.skipIf(process.platform === "win32")("retained sessions across a generation handoff", () => {
	it("emits session_parked with a path and the session is reopened by path with the same durable id", async () => {
		const rig = await startHandoverRig("ih-retained");
		scratches.push(rig.qa);
		pids.push(rig.firstPid);

		// Open a retained session on generation A, then detach so it is idle-but-retained.
		const opener = await connect(rig, peers);
		const opened = dataOf(
			await opener.request({
				id: "open",
				type: "open_session",
				cwd: rig.qa.cwd,
				retain_on_disconnect: true,
			}),
		);
		const sessionId = opened.sessionId as string;
		const openedState = opened.state as { durableSessionId?: string; sessionFile?: string } | undefined;
		const durableId =
			typeof openedState?.durableSessionId === "string"
				? openedState.durableSessionId
				: /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
						openedState?.sessionFile ?? "",
					)?.[1];
		expect(typeof sessionId).toBe("string");
		expect(typeof durableId).toBe("string");

		// session_parked is delivered only to connections attached to the session, so watch on the opener.
		const parked = opener.waitFor(
			(record) => record.type === "session_parked" && record.sessionId === sessionId,
			120_000,
		);
		const caller = await connect(rig, peers);
		const answer = dataOf(await caller.request(beginHandoverCommand(rig), 120_000));
		expect(answer).toMatchObject({ operation_id: "op-1", state: "handover_completed" });
		const successor = answer.successor as { pid: number; runtimeBuildId: string };
		pids.push(successor.pid);
		expect(successor.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		expect(await waitForPidGone(rig.firstPid, 60_000)).toBe(true);

		const seen = () => opener.messages.map((m) => `${String(m.type)}:${String(m.sessionId ?? "")}`).join(",");
		const park = await parked.catch((cause: unknown) => {
			throw new Error(`no session_parked; opener saw [${seen()}]: ${String(cause)}`);
		});
		expect(park).toMatchObject({ type: "session_parked", sessionId });
		const sessionPath = park.sessionPath as string;
		expect(typeof sessionPath).toBe("string");

		// The successor serves; a client reopening by the parked path gets the SAME durable id.
		const after = await probeHost({ socket: rig.qa.socket });
		expect(after?.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		const reopener = await connect(rig, peers);
		const reopened = dataOf(
			await reopener.request({
				id: "reopen",
				type: "open_session",
				sessionPath,
				cwd: rig.qa.cwd,
				retain_on_disconnect: true,
			}),
		);
		const reopenedState = reopened.state as { durableSessionId?: string; sessionFile?: string } | undefined;
		const reopenedDurable =
			typeof reopenedState?.durableSessionId === "string"
				? reopenedState.durableSessionId
				: /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
						reopenedState?.sessionFile ?? "",
					)?.[1];
		expect(reopenedDurable).toBe(durableId);

		const status = await readHostStatus({ socket: rig.qa.socket, agentDir: rig.qa.agentDir });
		const current = status.generations.find((row) => row.current);
		if (current !== undefined) pids.push(current.pid);
	}, 240_000);
});
