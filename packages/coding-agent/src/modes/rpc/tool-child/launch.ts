import { type ChildProcess, spawn } from "node:child_process";
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
	return { command: process.execPath, args: [...runtimeExecArgv(), resolveCliMainPath()] };
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
