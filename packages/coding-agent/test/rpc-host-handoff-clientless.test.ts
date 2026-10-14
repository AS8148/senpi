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

describe.skipIf(process.platform === "win32")("client-less retained sessions across a generation handoff", () => {
	it("the successor host reopens the predecessor's handoff_parked retained session with the same durable id", async () => {
		const rig = await startHandoverRig("ih-clientless");
		scratches.push(rig.qa);
		pids.push(rig.firstPid);

		const opener = await connect(rig, peers);
		const opened = dataOf(
			await opener.request({
				id: "open",
				type: "open_session",
				cwd: rig.qa.cwd,
				retain_on_disconnect: true,
			}),
		);
		const openedState = opened.state as { durableSessionId?: string; sessionFile?: string } | undefined;
		// A real retained session has a transcript on disk; the file is written incrementally during a
		// turn. Drive one turn so the file exists, then abort it (the conditional handover waits for no
		// busy session; the retry below absorbs the abort's settle timing).
		await opener.request({ id: "turn", type: "prompt", sessionId: opened.sessionId, message: "say ok" }, 120_000);
		await opener.request({ id: "abort", type: "abort", sessionId: opened.sessionId }, 120_000);
		const durableId =
			typeof openedState?.durableSessionId === "string"
				? openedState.durableSessionId
				: /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
						openedState?.sessionFile ?? "",
					)?.[1];
		expect(typeof durableId).toBe("string");
		opener.destroy();

		const caller = await connect(rig, peers);
		// The conditional idle handover refuses while the just-aborted turn is still settling; retry
		// until it admits the handoff, so the test does not hinge on the abort's settle timing.
		let answer: Record<string, unknown> = {};
		const handoffDeadline = Date.now() + 120_000;
		for (;;) {
			answer = dataOf(await caller.request(beginHandoverCommand(rig), 120_000));
			if (answer.state === "handover_completed") break;
			if (Date.now() >= handoffDeadline) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		expect(answer).toMatchObject({ operation_id: "op-1", state: "handover_completed" });
		const successor = answer.successor as { pid: number; runtimeBuildId: string };
		pids.push(successor.pid);
		expect(successor.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		expect(await waitForPidGone(rig.firstPid, 60_000)).toBe(true);

		const after = await probeHost({ socket: rig.qa.socket });
		expect(after?.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		const status = await readHostStatus({ socket: rig.qa.socket, agentDir: rig.qa.agentDir });
		const current = status.generations.find((row) => row.current);
		if (current !== undefined) pids.push(current.pid);

		const lister = await connect(rig, peers);
		const listDurableIds = async (): Promise<string[]> => {
			const listed = dataOf(await lister.request({ id: "list", type: "list_sessions", include_workers: true }));
			return ((listed.sessions ?? []) as Array<{ durableSessionId?: string }>)
				.map((row) => row.durableSessionId)
				.filter((id): id is string => typeof id === "string");
		};

		// After the first handover the session must be OPEN with the same durable id: a successor
		// that leaves it only in the parked record (or drops it) FAILS, because the production bug is
		// exactly that the reopened session never comes back open (senpi#3282).
		const deadline1 = Date.now() + 60_000;
		let openAfterFirst = false;
		while (!openAfterFirst && Date.now() < deadline1) {
			openAfterFirst = (await listDurableIds()).includes(durableId!);
			if (!openAfterFirst) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		expect(openAfterFirst, `durable ${durableId} not open after the first handover`).toBe(true);

		// After a SECOND handover the session is open again with the same durable id.
		const successorInfo = answer.successor as { instanceId: string; generation: number; runtimeBuildId: string };
		const caller2 = await connect(rig, peers);
		const answer2 = dataOf(
			await caller2.request(
				beginHandoverCommand(rig, {
					operation_id: "op-2",
					if_instance_id: successorInfo.instanceId,
					if_generation: successorInfo.generation,
					target_runtime_build_id: rig.buildA.runtimeBuildId,
					host_args: rig.buildA.hostArgs,
				}),
				120_000,
			),
		);
		expect(answer2, `second handover did not complete: ${JSON.stringify(answer2)}`).toMatchObject({
			state: "handover_completed",
		});
		const deadline2 = Date.now() + 60_000;
		let openAgain = false;
		while (!openAgain && Date.now() < deadline2) {
			openAgain = (await listDurableIds()).includes(durableId!);
			if (!openAgain) await new Promise((resolve) => setTimeout(resolve, 250));
		}
		expect(openAgain, `durable ${durableId} not open after the second handover`).toBe(true);
	}, 300_000);
});
