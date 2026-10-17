/**
 * The tool child's main loop (senpi#3566, plan todo 4). It reaches its server only through the private channel, runs
 * each `job` frame through the handler registered for its kind, and exits when the server goes away (parent-watch),
 * so a child can never outlive the session that owns it. It loads no session, provider, extension or MCP scope: the
 * server is the single writer of every session file.
 */
import { connectChannel, type ToolChildChannel } from "./channel.ts";
import { LaunchGate } from "./launch-gate.ts";
import type { ToolChildMessageOf } from "./protocol.ts";

export const TOOL_CHILD_GENERATION_ENV = "SENPI_TOOL_CHILD_GENERATION";
export const TOOL_CHILD_PROTOCOL_VERSION = 1;

export interface ToolChildJobContext {
	readonly jobId: string;
	readonly signal: AbortSignal;
	readonly channel: ToolChildChannel;
	readonly gate: LaunchGate;
}

export type ToolChildJobHandler = (args: unknown, context: ToolChildJobContext) => Promise<unknown>;

export interface ToolChildEntryOptions {
	readonly handlers: Readonly<Record<string, ToolChildJobHandler>>;
	readonly env?: NodeJS.ProcessEnv;
	readonly exit?: (code: number) => never;
}

export class ToolChildJobError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
		this.name = "ToolChildJobError";
	}
}

export async function runToolChild(options: ToolChildEntryOptions): Promise<void> {
	const env = options.env ?? process.env;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const generation = Number(env[TOOL_CHILD_GENERATION_ENV]);
	if (!Number.isSafeInteger(generation) || generation < 0) {
		process.stderr.write("tool-child: invalid generation\n");
		exit(70);
	}
	const channel = await connectChannel(env);
	const running = new Map<string, AbortController>();
	const gate = new LaunchGate(channel);
	channel.onMessage((message) => {
		if (gate.handle(message)) return;
		switch (message.type) {
			case "ping":
				channel.send({ type: "pong", seq: message.seq });
				return;
			case "job":
				void runJob(channel, gate, options.handlers, running, message);
				return;
			case "cancel":
				running.get(message.jobId)?.abort();
				return;
			case "shutdown":
				channel.close();
				return;
			default:
				return;
		}
	});
	channel.send({ type: "hello", generation, pid: process.pid, protocol: TOOL_CHILD_PROTOCOL_VERSION });
	await channel.closed;
	for (const controller of running.values()) controller.abort();
	exit(0);
}

async function runJob(
	channel: ToolChildChannel,
	gate: LaunchGate,
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
		const value = await handler(job.args, { jobId: job.jobId, signal: controller.signal, channel, gate });
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
