/**
 * The `launch-shim` role (senpi#3566, plan todo 4, Windows): started by a tool child for an explicit `detached: true`
 * launch. It starts the command outside the child's Job Object, writes `{"pid":N}` on fd 3 so the child can report
 * `command_started{breakaway:true}`, waits, and exits with the command's exit code. The shim itself stays in the job.
 */
import { writeSync } from "node:fs";
import { loadKernel32Process, startBreakaway } from "./windows-breakaway.ts";

export const LAUNCH_SHIM_ARGV_ENV = "SENPI_LAUNCH_SHIM_ARGV";
/** How to re-enter this engine (set by the server when it starts the tool child); the shim is started the same way. */
export const TOOL_CHILD_REENTRY_ENV = "SENPI_TOOL_CHILD_REENTRY";
const PID_FD = 3;

export function parseShimArgv(raw: string | undefined): string[] | undefined {
	if (raw === undefined || raw === "") return undefined;
	const parsed: unknown = JSON.parse(raw);
	return Array.isArray(parsed) && parsed.length > 0 && parsed.every((part) => typeof part === "string")
		? parsed
		: undefined;
}

export function runLaunchShimRole(env: NodeJS.ProcessEnv = process.env): never {
	const argv = parseShimArgv(env[LAUNCH_SHIM_ARGV_ENV]);
	const kernel = loadKernel32Process();
	if (argv === undefined || kernel === undefined) {
		process.stderr.write(`launch-shim: ${argv === undefined ? "argv unavailable" : "kernel32 unavailable"}\n`);
		process.exit(70);
	}
	const command = startBreakaway(kernel, argv);
	writeSync(PID_FD, `${JSON.stringify({ pid: command.pid })}\n`);
	process.exit(command.wait());
}
