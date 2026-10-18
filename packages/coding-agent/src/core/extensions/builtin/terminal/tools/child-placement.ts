/**
 * Places a terminal tool on the session's tool child (senpi#3566 todo 9): `placement: "child"` plus the job that runs
 * the same body there (`terminal-jobs.ts`). The job's arguments are built on the server from what the body would read
 * in-process - the shell environment with the session's PI_* overrides, the shell path, the default size, the cwd - so
 * the command sees the same environment wherever it runs. Under `--tool-runtime in-process` the placement is ignored and
 * `execute` runs here, unchanged.
 */
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

export function terminalChildJob(
	ctx: TerminalToolContext,
	kind: (typeof TERMINAL_CHILD_JOB_KINDS)[keyof typeof TERMINAL_CHILD_JOB_KINDS],
): ToolChildJob {
	return {
		kind,
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
