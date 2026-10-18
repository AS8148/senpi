/**
 * Places a terminal tool on the session's tool child (senpi#3566 todo 9): `placement: "child"` plus the job that runs
 * the same body there (`terminal-jobs.ts`). The job's arguments are built on the server from what the body would read
 * in-process - the shell environment with the session's PI_* overrides, the shell path, the default size, the cwd - so
 * the command sees the same environment wherever it runs. Under `--tool-runtime in-process` the placement is ignored and
 * `execute` runs here, unchanged.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionToolContext, ToolChildJob } from "../../../types.ts";
import { sessionEnvOverrides } from "./bash.ts";
import type { TerminalToolContext } from "./context.ts";

export const TERMINAL_CHILD_JOB_KINDS = {
	bash: "terminal.bash",
	output: "terminal.output",
	input: "terminal.input",
	resize: "terminal.resize",
	kill: "terminal.kill",
} as const;

/**
 * The child generation each background session was started on. A session lives in its child's TerminalManager, so
 * once that generation exits the id is gone; a later call reaching a new child would read "unknown id", and this map
 * turns that into "lost" so the model learns the session died with its child rather than that it never existed.
 */
export type TerminalSessionGenerations = Map<string, number>;

function bashIdOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const id = (value as { bash_id?: unknown }).bash_id;
	return typeof id === "string" ? id : undefined;
}

export function lostSessionResult(id: string, generation: number): AgentToolResult<unknown> {
	return {
		content: [
			{
				type: "text",
				text: `bash_id ${id} is lost: the session's tool child (generation ${generation}) exited, which ended this session and every process it started. Start a new session with bash.`,
			},
		],
		details: { bash_id: id, lost: true, generation },
	};
}

export function terminalChildJob(
	ctx: TerminalToolContext,
	kind: (typeof TERMINAL_CHILD_JOB_KINDS)[keyof typeof TERMINAL_CHILD_JOB_KINDS],
	generations: TerminalSessionGenerations,
): ToolChildJob {
	return {
		kind,
		result: (params, value, generation) => {
			if (kind === TERMINAL_CHILD_JOB_KINDS.bash) {
				const started = bashIdOf(value.details);
				if (started !== undefined) generations.set(started, generation);
				return value;
			}
			const id = bashIdOf(params);
			if (id === undefined) return value;
			const startedOn = generations.get(id);
			if (startedOn === undefined || startedOn === generation) return value;
			generations.delete(id);
			return lostSessionResult(id, startedOn);
		},
		args: (params: unknown, toolCallId: string, execCtx: ExtensionToolContext) => {
			const env: Record<string, string> = {};
			for (const [name, value] of Object.entries(ctx.getEnv())) if (typeof value === "string") env[name] = value;
			return {
				params,
				toolCallId,
				cwd: execCtx.cwd ?? ctx.cwd,
				env: { ...env, ...sessionEnvOverrides(ctx, execCtx) },
				...(ctx.shellPath === undefined ? {} : { shellPath: ctx.shellPath }),
				defaultCols: ctx.defaultCols,
				defaultRows: ctx.defaultRows,
			};
		},
	};
}
