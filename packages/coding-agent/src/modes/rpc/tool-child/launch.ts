import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { isBunBinary } from "../../../config.ts";
import { runtimeExecArgv } from "../../../utils/runtime-exec-argv.ts";
import { resolveCliMainPath } from "../host-cli-entry.ts";
import { TOOL_CHILD_ROLE_ENV } from "./channel.ts";
import { TOOL_CHILD_GENERATION_ENV } from "./entry.ts";

export interface ToolChildCommand {
	readonly command: string;
	readonly args: readonly string[];
}

/**
 * How this engine re-enters itself as a tool child: a compiled binary boots its embedded entry with the role in its
 * environment, an interpreted install runs its own CLI entry under the same runtime. Never a PATH lookup.
 */
export function toolChildCommand(compiled: boolean = isBunBinary): ToolChildCommand {
	if (compiled) return { command: process.execPath, args: [] };
	return { command: process.execPath, args: [...runtimeExecArgv(), toolChildEntryPath()] };
}

/** The dedicated role entry beside the CLI entry, so an interpreted child parses none of the CLI graph. */
export function toolChildEntryPath(cliMainPath: string = resolveCliMainPath()): string {
	const extension = extname(cliMainPath);
	const dedicated = join(dirname(cliMainPath), `tool-child-main${extension}`);
	return existsSync(dedicated) ? dedicated : cliMainPath;
}

export function spawnToolChild(options: {
	readonly generation: number;
	readonly channelEnv: Readonly<Record<string, string>>;
	readonly env: NodeJS.ProcessEnv;
	readonly command: ToolChildCommand;
	readonly cwd: string;
}): ChildProcess {
	return spawn(options.command.command, [...options.command.args], {
		cwd: options.cwd,
		env: {
			...options.env,
			...options.channelEnv,
			[TOOL_CHILD_ROLE_ENV]: "tool-child",
			[TOOL_CHILD_GENERATION_ENV]: String(options.generation),
		},
		// POSIX: the child leads its own group, so its whole tree can be signalled as one. Windows: the job is the handle.
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
}
