/**
 * `node:child_process` behind the execution barrier, for code running in a tool-child worker (senpi#3566, plan
 * todo 4; the per-API table in DESIGN PART 1). Synchronous and `exec*` launches stay in the child's own (ledgered)
 * group and run only after the ack. `spawn` without `detached` and with `detached: true` leads its own group through
 * the POSIX shim, so the handle is on record before the program runs; `detached: true` is ledgered as detached and
 * never swept. `fork` keeps its IPC channel, so it stays in the child's group (ack-gated). The worker blocks until the
 * ack in every case, so a caller can never write to a shim's stdin before its go-line.
 */
import type * as ChildProcessModule from "node:child_process";
import type { ChildProcess, IOType, SpawnOptions, StdioOptions } from "node:child_process";
import { Socket } from "node:net";
import { promisify } from "node:util";
import { controlFd, enoentError, goShimScript, shimTarget, withControlPipe } from "./go-shim.ts";
import type { LaunchApi } from "./protocol.ts";
import type { WorkerLaunchClient } from "./worker-launch.ts";

type ChildProcessApi = typeof ChildProcessModule;
/** One entry of a spawn `stdio` array. */
type StdioEntry = Exclude<StdioOptions, IOType>[number];

function isArgList(value: readonly string[] | SpawnOptions | undefined): value is readonly string[] {
	return Array.isArray(value);
}

/** Reports the launch done exactly once: on exit, or on a spawn error (which may precede the shim's own exit). */
function trackExit(client: WorkerLaunchClient, launchId: string, child: ChildProcess): ChildProcess {
	let reported = false;
	const report = (outcome: { readonly exitCode: number | null; readonly signal?: NodeJS.Signals | null }) => {
		if (reported) return;
		reported = true;
		client.done(launchId, outcome);
	};
	child.once("exit", (exitCode, signal) => report({ exitCode, signal }));
	child.once("error", () => report({ exitCode: 1 }));
	return child;
}

function runInherited<T>(
	client: WorkerLaunchClient,
	api: LaunchApi,
	call: () => T,
	statusOf: (value: T) => number | null,
): T {
	const launchId = client.acquire({ origin: "kernel", api, containment: "inherited", lifetime: "owned" });
	client.invoke(launchId);
	try {
		const value = call();
		client.done(launchId, { exitCode: statusOf(value) });
		return value;
	} catch (error) {
		const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 1;
		client.done(launchId, { exitCode: status });
		throw error;
	}
}

function ownGroupSpawn(
	real: ChildProcessApi,
	client: WorkerLaunchClient,
	command: string,
	args: readonly string[],
	options: SpawnOptions,
	lifetime: "owned" | "detached",
): ChildProcess {
	const callerStdio: StdioEntry[] = Array.isArray(options.stdio)
		? [...options.stdio]
		: [options.stdio ?? "pipe", options.stdio ?? "pipe", options.stdio ?? "pipe"];
	const fd = controlFd(callerStdio);
	const target = shimTarget(command, args, options.shell);
	const shim = real.spawn("/bin/sh", ["-c", goShimScript(fd), target.program, ...target.args], {
		...options,
		shell: false,
		detached: true,
		stdio: withControlPipe<StdioEntry>(callerStdio, fd, "ignore", "pipe"),
	});
	if (shim.pid === undefined) return shim;
	const launchId = client.acquire({
		origin: "kernel",
		api: "cp.spawn",
		containment: "own-group",
		lifetime,
		pid: shim.pid,
		pgid: shim.pid,
	});
	trackExit(client, launchId, shim);
	client.invoke(launchId);
	const control: unknown = shim.stdio[fd];
	if (control instanceof Socket) {
		let reply = "";
		control.on("data", (chunk: Buffer) => {
			reply += chunk.toString("utf8");
			if (reply.startsWith("ENOENT")) shim.emit("error", enoentError(command, args));
		});
		// The command closed its copy at exec; the parent's end is only for the go line and the ENOENT reply.
		control.on("error", () => {});
		shim.once("exit", () => control.destroy());
		control.unref();
		control.write("go\n");
	}
	return shim;
}

/**
 * Node's `exec` / `execFile` carry a `util.promisify.custom` that resolves `{ stdout, stderr }`; a gated replacement
 * must too, or `promisify(exec)` silently resolves the stdout string alone. It calls the gated function, so the promised
 * form passes the barrier like the callback form, and like Node it rejects with `stdout`/`stderr` on the error and
 * exposes the process as `.child`.
 */
function withPromisified<F extends (...args: never[]) => ChildProcess>(gated: F): F {
	const promised = (...args: unknown[]) => {
		let child: ChildProcess | undefined;
		const result = new Promise<{ stdout: unknown; stderr: unknown }>((resolve, reject) => {
			child = Reflect.apply(gated, undefined, [
				...args,
				(error: Error | null, stdout: unknown, stderr: unknown) =>
					error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }),
			]);
		});
		return Object.assign(result, { child });
	};
	Object.defineProperty(gated, promisify.custom, { value: promised });
	return gated;
}

/** A `node:child_process` module object whose launch APIs pass the execution barrier. Non-launch exports pass through. */
export function createGatedChildProcess(module: ChildProcessApi, client: WorkerLaunchClient): ChildProcessApi {
	// Captured before anyone patches `module` in place: the gated functions must call the originals, never themselves.
	const real: ChildProcessApi = {
		...module,
		spawn: module.spawn,
		spawnSync: module.spawnSync,
		exec: module.exec,
		execSync: module.execSync,
		execFile: module.execFile,
		execFileSync: module.execFileSync,
		fork: module.fork,
	};
	const posix = process.platform !== "win32";
	const spawn = (
		command: string,
		argsOrOptions?: readonly string[] | SpawnOptions,
		maybeOptions?: SpawnOptions,
	): ChildProcess => {
		const args = isArgList(argsOrOptions) ? argsOrOptions : [];
		const options: SpawnOptions = (isArgList(argsOrOptions) ? maybeOptions : argsOrOptions) ?? {};
		if (posix && options.detached !== false)
			return ownGroupSpawn(real, client, command, args, options, options.detached === true ? "detached" : "owned");
		const launchId = client.acquire({
			origin: "kernel",
			api: "cp.spawn",
			containment: "inherited",
			lifetime: "owned",
		});
		client.invoke(launchId);
		return trackExit(client, launchId, real.spawn(command, [...args], options));
	};
	const asyncInherited =
		<F extends (...args: never[]) => ChildProcess>(api: LaunchApi, original: F) =>
		(...args: Parameters<F>): ChildProcess => {
			const launchId = client.acquire({ origin: "kernel", api, containment: "inherited", lifetime: "owned" });
			client.invoke(launchId);
			return trackExit(client, launchId, original(...args));
		};
	const gated: Record<string, unknown> = {
		...real,
		spawn,
		exec: withPromisified(asyncInherited("cp.spawn", real.exec)),
		execFile: withPromisified(asyncInherited("cp.spawn", real.execFile)),
		fork: asyncInherited("cp.spawn", real.fork),
		spawnSync: (...args: Parameters<ChildProcessApi["spawnSync"]>) =>
			runInherited(
				client,
				"cp.spawnSync",
				() => real.spawnSync(...args),
				(result) => result.status,
			),
		execSync: (...args: Parameters<ChildProcessApi["execSync"]>) =>
			runInherited(
				client,
				"cp.execFileSync",
				() => real.execSync(...args),
				() => 0,
			),
		execFileSync: (...args: Parameters<ChildProcessApi["execFileSync"]>) =>
			runInherited(
				client,
				"cp.execFileSync",
				() => real.execFileSync(...args),
				() => 0,
			),
	};
	gated.default = gated;
	return gated as unknown as ChildProcessApi;
}
