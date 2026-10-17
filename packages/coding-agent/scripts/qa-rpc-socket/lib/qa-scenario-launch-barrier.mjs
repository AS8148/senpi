/**
 * `4-launch-apis-ack-gated` (senpi#3566 todo 4): with every ack held (`HOLD_LAUNCH_ACK`), the scripted model calls
 * `qa_spawn` once per launch API. For each launch the driver reads `launch` from the session's `launches.jsonl`,
 * queries the child's slot counts and asserts nothing ran (`invocations === 0`), then releases the ack. The gated
 * `bun.spawnSync` launch is released through its FIFO only after the driver saw its proof and the host still answered
 * while the synchronous launch blocked its worker. At the end every launch ran exactly once, after its ack, with the
 * containment and lifetime its API promises, and nothing was reported as a violation.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { kill } from "node:process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkLaunchLog } from "./qa-launch-log.mjs";
import { launchLog } from "./qa-launch-tail.mjs";
import { QaFailure } from "./qa-failure.mjs";

const CALLS = [
	{ api: "bun.spawn", args: { api: "bun.spawn", argv: ["true"] }, containment: "own-group", lifetime: "owned" },
	{ api: "bun.spawnSync", args: { api: "bun.spawnSync", argv: ["true"], gate: true }, containment: "inherited", lifetime: "owned" },
	{ api: "bun.shell", args: { api: "bun.shell", argv: ["true"] }, containment: "inherited", lifetime: "owned" },
	{ api: "cp.spawn", args: { api: "cp.spawn", argv: ["sleep", "300"], detached: true }, containment: "own-group", lifetime: "detached" },
	{ api: "cp.spawn", args: { api: "cp.spawn", argv: ["true"], detached: false }, containment: "inherited", lifetime: "owned" },
	{ api: "cp.execFileSync", args: { api: "cp.execFileSync", argv: ["true"] }, containment: "inherited", lifetime: "owned" },
];
const STEPS = [...CALLS.map((call) => ({ tool: "qa_spawn", args: call.args })), { text: "launch APIs done" }];

function assert(condition, message) {
	if (!condition) throw new QaFailure("assertion_failed", message);
}

async function slotState(ctx, log, launchId, query) {
	const isState = (r) => r.type === "slot_state" && r.launchId === launchId;
	const seen = log.read().filter(isState).length;
	await writeFile(join(ctx.controlDir, `query-slot-${launchId}.${query}`), "");
	return log.waitForNth(isState, seen + 1, { name: `slot_state ${launchId} #${query}` });
}

function alive(pid) {
	try {
		kill(pid, 0);
	} catch {
		return false;
	}
	const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
	return state !== "" && !state.startsWith("Z");
}

export const launchApisAckGatedScenario = Object.freeze({
	id: "4-launch-apis-ack-gated",
	requires: [4],
	needsExtension: true,
	model(body) {
		const toolMessages = (body.messages ?? []).filter((message) => message.role === "tool").length;
		return STEPS[Math.min(toolMessages, STEPS.length - 1)];
	},
	async run(ctx) {
		const sessionId = await ctx.openSession();
		const settled = ctx.awaitRecord((r) => r.sessionId === sessionId && r.type === "agent_settled", { name: "agent_settled", deadlineMs: 240_000 });
		const spawned = ctx.awaitRecord((r) => r.sessionId === sessionId && r.type === "session_tool_child" && r.state === "spawned", { name: "session_tool_child spawned", deadlineMs: 120_000 });
		const ends = [];
		const unsubscribe = ctx.rpc.subscribe((r) => {
			if (r.sessionId === sessionId && r.type === "tool_execution_end" && r.toolName === "qa_spawn") ends.push(r);
		});
		await ctx.prompt(sessionId, "run every launch API once");
		const child = await spawned;
		const log = launchLog(ctx.agentDir, ctx.durableSessionIdOf(sessionId));
		const launchIds = [];
		for (const [index, call] of CALLS.entries()) {
			const launch = await log.waitFor((r) => r.type === "launch" && !launchIds.includes(r.launchId), { name: `launch #${index} (${call.api})`, deadlineMs: 60_000 });
			launchIds.push(launch.launchId);
			const held = await slotState(ctx, log, launch.launchId, 1);
			ctx.log.write({ type: "assert", step: "held", api: call.api, launchId: launch.launchId, invocations: held.invocations });
			assert(held.invocations === 0, `${call.api} ran before its ack (invocations ${held.invocations})`);
			await ctx.control.releaseAck(launch.launchId);
			if (call.args.gate === true) {
				await log.waitFor((r) => r.type === "launch_proof" && r.launchId === launch.launchId, { name: `proof ${launch.launchId}` });
				for (const probe of [1, 2]) {
					const info = await ctx.rpc.request({ type: "get_protocol_info" });
					assert(info.success === true, `host stopped answering while the gated launch blocked (probe ${probe})`);
				}
				assert(!log.read().some((r) => r.type === "launch_done" && r.launchId === launch.launchId), "the gated launch finished before its gate opened");
				ctx.log.write({ type: "assert", step: "gated_blocking", launchId: launch.launchId, hostAnswered: 2 });
				const fixtureLaunchId = await ctx.awaitControlFile((name) => name.startsWith("gate-"));
				await ctx.control.releaseGate(fixtureLaunchId.slice("gate-".length));
			}
		}
		await settled;
		unsubscribe();
		assert(ends.length === CALLS.length, `expected ${CALLS.length} qa_spawn results, saw ${ends.length}`);
		const records = log.read();
		copyFileSync(log.path, join(ctx.evidenceDir, "launches.jsonl"));
		assert(!records.some((r) => r.type === "violation"), "a barrier violation was recorded");
		const audit = checkLaunchLog(records);
		ctx.log.write({ type: "assert", step: "launch_log_audit", ok: audit.ok, failures: audit.failures });
		assert(audit.ok, `launches.jsonl audit failed: ${JSON.stringify(audit.failures)}`);
		for (const [index, call] of CALLS.entries()) {
			const launchId = launchIds[index];
			const launch = records.find((r) => r.type === "launch" && r.launchId === launchId);
			const proofs = records.filter((r) => r.type === "launch_proof" && r.launchId === launchId);
			const final = await slotState(ctx, log, launchId, 2);
			const details = ends[index].result?.details ?? {};
			ctx.log.write({ type: "assert", step: "final", api: call.api, launchId, launch, proofs, final, details });
			assert(final.invocations === 1, `${call.api} ran ${final.invocations} times`);
			assert(proofs.length === 1 && proofs[0].ackTick !== null && proofs[0].ackTick < proofs[0].invokeTick, `${call.api} proof out of order`);
			assert(launch.containment === call.containment && launch.lifetime === call.lifetime, `${call.api} containment ${launch.containment}/${launch.lifetime}`);
			assert(details.markerSeen === true, `${call.api} marker not seen`);
			const expectedGroup = call.containment === "own-group" ? details.pid : child.pid;
			assert(details.pgid === expectedGroup, `${call.api} pgid ${details.pgid}, expected ${expectedGroup}`);
			if (call.lifetime === "detached") {
				assert(alive(details.pid), `the detached fixture ${details.pid} was not alive to clean up`);
				kill(details.pid, "SIGKILL");
				const gone = await ctx.awaitGone(details.pid);
				ctx.log.write({ type: "fixture_cleanup", launchId, pid: details.pid, method: "SIGKILL", gone });
				assert(gone, `detached fixture ${details.pid} survived SIGKILL`);
			}
		}
	},
});
