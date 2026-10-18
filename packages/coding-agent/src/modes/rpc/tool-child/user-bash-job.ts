/**
 * The session's user bash (`!cmd`, `AgentSession.executeBash`) as a tool-child job (senpi#3566 todo 9): the command
 * runs on the session's child through the launch barrier (`launchOwnGroup`), its output streams back as job updates
 * (`{ data: <base64> }`), and the result is the exit code (signal terminations as 128 + signal number). Interception,
 * events, recording and `excludeFromContext` stay on the server; this job only runs the process.
 */
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { getShellConfig } from "../../../utils/shell.ts";
import type { ToolChildJobContext, ToolChildJobHandler } from "./entry.ts";
import { ToolChildJobError } from "./entry-error.ts";
import { launchOwnGroup } from "./launch-barrier.ts";

export const USER_BASH_JOB_KIND = "user.bash";

export interface UserBashJobArgs {
	readonly command: string;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly shellPath?: string;
	readonly timeoutSeconds?: number;
}

/** One streamed chunk of output; base64 so binary output survives the JSON channel. */
export interface UserBashUpdate {
	readonly data: string;
}

export function parseUserBashArgs(value: unknown): UserBashJobArgs {
	const field = (name: string): unknown =>
		typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
	const command = field("command");
	const cwd = field("cwd");
	const env = field("env");
	if (typeof command !== "string" || typeof cwd !== "string" || typeof env !== "object" || env === null)
		throw new ToolChildJobError("user_bash_bad_args", "a user bash job needs command, cwd and env");
	const shellPath = field("shellPath");
	const timeoutSeconds = field("timeoutSeconds");
	return {
		command,
		cwd,
		env: Object.fromEntries(
			Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		),
		...(typeof shellPath === "string" ? { shellPath } : {}),
		...(typeof timeoutSeconds === "number" && timeoutSeconds > 0 ? { timeoutSeconds } : {}),
	};
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The group already exited.
	}
}

async function runUserBash(args: UserBashJobArgs, job: ToolChildJobContext): Promise<{ exitCode: number | null }> {
	await access(args.cwd).catch(() => {
		throw new ToolChildJobError(
			"user_bash_bad_cwd",
			`Working directory does not exist: ${args.cwd}\nCannot execute bash commands.`,
		);
	});
	const shell = getShellConfig(args.shellPath);
	const fromStdin = shell.commandTransport === "stdin";
	const launched = await launchOwnGroup({
		gate: job.gate,
		jobId: job.jobId,
		origin: "user_bash",
		api: "cp.spawn",
		program: shell.shell,
		args: fromStdin ? shell.args : [...shell.args, args.command],
		options: { cwd: args.cwd, env: { ...args.env }, stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"] },
	});
	const { child } = launched;
	if (fromStdin) {
		child.stdin?.on("error", () => {});
		child.stdin?.end(args.command);
	}
	const forward = (chunk: Buffer) => void job.update({ data: chunk.toString("base64") } satisfies UserBashUpdate);
	child.stdout?.on("data", forward);
	child.stderr?.on("data", forward);
	const pid = child.pid;
	const stop = () => {
		if (pid !== undefined) killGroup(pid);
	};
	job.signal.addEventListener("abort", stop, { once: true });
	const timer = args.timeoutSeconds === undefined ? undefined : setTimeout(stop, args.timeoutSeconds * 1000);
	try {
		const { exitCode, signal } = await launched.exited;
		if (job.signal.aborted) throw new ToolChildJobError("user_bash_aborted", "aborted");
		if (exitCode !== null) return { exitCode };
		return { exitCode: signal === null ? null : 128 + (osConstants.signals[signal] ?? 0) };
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		job.signal.removeEventListener("abort", stop);
	}
}

export function createUserBashJobHandler(): ToolChildJobHandler {
	return (value, job) => {
		if (process.platform === "win32")
			throw new ToolChildJobError("tool_child_platform_unsupported", "user bash on the tool child is POSIX-only");
		return runUserBash(parseUserBashArgs(value), job);
	};
}
