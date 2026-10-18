/**
 * The tool child's main loop (senpi#3566, plan todo 4). It reaches its server only through the private channel, runs
 * each `job` frame through the handler registered for its kind, and exits when the server goes away (parent-watch),
 * so a child can never outlive the session that owns it. It loads no session, provider, extension or MCP scope: the
 * server is the single writer of every session file.
 */
import { connectChannel, type ToolChildChannel } from "./channel.ts";
import { ChildHostCalls, type HostCallTarget } from "./host-calls-child.ts";
import { LaunchGate } from "./launch-gate.ts";
import type { ToolChildMessageOf } from "./protocol.ts";
import { readTestControls } from "./test-controls.ts";

export const TOOL_CHILD_GENERATION_ENV = "SENPI_TOOL_CHILD_GENERATION";
export const TOOL_CHILD_PROTOCOL_VERSION = 1;

export interface ToolChildJobContext {
	readonly jobId: string;
	readonly signal: AbortSignal;
	readonly channel: ToolChildChannel;
	readonly gate: LaunchGate;
	/** A call to the server for this job (reverse bridge); settles with its reply, refusal or the job's cancel. */
	readonly hostCall: (target: HostCallTarget) => Promise<unknown>;
}

export type ToolChildJobHandler = (args: unknown, context: ToolChildJobContext) => Promise<unknown>;

export interface ToolChildEntryOptions {
	readonly handlers: Readonly<Record<string, ToolChildJobHandler>>;
	readonly env?: NodeJS.ProcessEnv;
	readonly exit?: (code: number) => never;
}

export { ToolChildJobError } from "./entry-error.ts";

import { ToolChildJobError } from "./entry-error.ts";

export async function runToolChild(options: ToolChildEntryOptions): Promise<void> {
	const env = options.env ?? process.env;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const generation = Number(env[TOOL_CHILD_GENERATION_ENV]);
	if (!Number.isSafeInteger(generation) || generation < 0) {
		process.stderr.write("tool-child: invalid generation\n");
		exit(70);
	}
	const channel = await connectChannel(env);
	const controls = readTestControls(env);
	if (controls.enabled("EXIT_ON_START")) exit(1);
	const running = new Map<string, AbortController>();
	const gate = new LaunchGate(channel);
	const hostCalls = new ChildHostCalls(channel);
	let readerBlocked = false;
	channel.onMessage((message) => {
		if (controls.enabled("BLOCK_READER") && !readerBlocked) {
			readerBlocked = true;
			// Test-only: the protocol loop stops reading for 30 s, so pings go unanswered.
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
		}
		if (gate.handle(message)) return;
		if (hostCalls.handle(message)) return;
		switch (message.type) {
			case "ping":
				channel.send({ type: "pong", seq: message.seq });
				return;
			case "job":
				if (controls.value("EXIT_MID_JOB") === message.kind) exit(1);
				void runJob(channel, gate, hostCalls, options.handlers, running, message);
				return;
			case "cancel":
				if (controls.enabled("IGNORE_CANCEL")) return;
				running.get(message.jobId)?.abort();
				channel.send({ type: "cancel_ack", jobId: message.jobId });
				return;
			case "shutdown":
				channel.close();
				return;
			default:
				return;
		}
	});
	if (!controls.enabled("HANG_BEFORE_READY"))
		channel.send({ type: "hello", generation, pid: process.pid, protocol: TOOL_CHILD_PROTOCOL_VERSION });
	if (controls.enabled("STOP_SELF")) process.kill(process.pid, "SIGSTOP");
	await channel.closed;
	hostCalls.close();
	for (const controller of running.values()) controller.abort();
	exit(0);
}

async function runJob(
	channel: ToolChildChannel,
	gate: LaunchGate,
	hostCalls: ChildHostCalls,
	handlers: Readonly<Record<string, ToolChildJobHandler>>,
	running: Map<string, AbortController>,
	job: ToolChildMessageOf<"job">,
): Promise<void> {
	const handler = handlers[job.kind];
	if (handler === undefined) {
		channel.send({
			type: "job_error",
			jobId: job.jobId,
			code: "tool_child_unknown_kind",
			message: `no handler for ${job.kind}`,
		});
		return;
	}
	if (running.has(job.jobId)) {
		channel.send({ type: "job_refused", jobId: job.jobId, code: "tool_child_duplicate_job" });
		return;
	}
	const controller = new AbortController();
	running.set(job.jobId, controller);
	try {
		const hostCall = (target: HostCallTarget) => hostCalls.call(job.jobId, target, controller.signal);
		const value = await handler(job.args, { jobId: job.jobId, signal: controller.signal, channel, gate, hostCall });
		channel.send({ type: "result", jobId: job.jobId, value: value ?? null });
	} catch (error) {
		const code =
			error instanceof ToolChildJobError
				? error.code
				: controller.signal.aborted
					? "tool_child_cancelled"
					: "tool_child_job_failed";
		channel.send({
			type: "job_error",
			jobId: job.jobId,
			code,
			message: error instanceof Error ? error.message : String(error),
		});
	} finally {
		running.delete(job.jobId);
	}
}
