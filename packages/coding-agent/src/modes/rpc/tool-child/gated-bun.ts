/**
 * Bun's launch globals behind the execution barrier, for a tool-child worker on the Bun runtime (senpi#3566, plan
 * todo 4; DESIGN PART 1 per-API table). `Bun.spawn` without `detached` and with `detached: true` leads its own group
 * through the POSIX shim; `Bun.spawnSync` and `Bun.$` stay in the child's ledgered group. The worker blocks until the
 * ack in every case, so the real call and every stdin write happen only after the server recorded the launch.
 */
import type { WorkerLaunchClient } from "./worker-launch.ts";

const GO_LINE_SHIM = 'IFS= read -r _go || exit 127; exec "$0" "$@"';

interface BunSubprocess {
	readonly pid: number;
	readonly exited: Promise<number>;
	readonly stdin?: { write(chunk: string): unknown; end(): unknown; flush?(): unknown } | number | null;
}

interface BunSpawnOptions {
	readonly cmd?: readonly string[];
	readonly stdin?: unknown;
	readonly detached?: boolean;
	readonly [key: string]: unknown;
}

export interface BunLaunchGlobals {
	spawn(commandOrOptions: readonly string[] | BunSpawnOptions, options?: BunSpawnOptions): BunSubprocess;
	spawnSync(
		commandOrOptions: readonly string[] | BunSpawnOptions,
		options?: BunSpawnOptions,
	): { readonly exitCode: number | null };
	$: (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
}

function isCommand(value: readonly string[] | BunSpawnOptions): value is readonly string[] {
	return Array.isArray(value);
}

function splitArgs(
	commandOrOptions: readonly string[] | BunSpawnOptions,
	options: BunSpawnOptions | undefined,
): { cmd: readonly string[]; opts: BunSpawnOptions } {
	if (isCommand(commandOrOptions)) return { cmd: commandOrOptions, opts: options ?? {} };
	const { cmd = [], ...rest } = commandOrOptions;
	return { cmd, opts: rest };
}

export function installGatedBun(bun: BunLaunchGlobals, client: WorkerLaunchClient): void {
	const real = { spawn: bun.spawn.bind(bun), spawnSync: bun.spawnSync.bind(bun), $: bun.$ };
	const posix = process.platform !== "win32";
	bun.spawn = (commandOrOptions, options) => {
		const { cmd, opts } = splitArgs(commandOrOptions, options);
		if (!posix || opts.detached === false) {
			const launchId = client.acquire({
				origin: "kernel",
				api: "bun.spawn",
				containment: "inherited",
				lifetime: "owned",
			});
			client.invoke(launchId);
			const child = real.spawn([...cmd], opts);
			void child.exited.then((exitCode) => client.done(launchId, { exitCode }));
			return child;
		}
		const userStdin = opts.stdin;
		const child = real.spawn(["/bin/sh", "-c", GO_LINE_SHIM, ...cmd], { ...opts, detached: true, stdin: "pipe" });
		const launchId = client.acquire({
			origin: "kernel",
			api: "bun.spawn",
			containment: "own-group",
			lifetime: opts.detached === true ? "detached" : "owned",
			pid: child.pid,
			pgid: child.pid,
		});
		void child.exited.then((exitCode) => client.done(launchId, { exitCode }));
		client.invoke(launchId);
		const stdin = child.stdin;
		if (stdin !== undefined && stdin !== null && typeof stdin !== "number") {
			stdin.write("go\n");
			if (userStdin !== "pipe") stdin.end();
			else stdin.flush?.();
		}
		return child;
	};
	bun.spawnSync = (commandOrOptions, options) => {
		const launchId = client.acquire({
			origin: "kernel",
			api: "bun.spawnSync",
			containment: "inherited",
			lifetime: "owned",
		});
		client.invoke(launchId);
		const result = real.spawnSync(commandOrOptions, options);
		client.done(launchId, { exitCode: result.exitCode });
		return result;
	};
	bun.$ = (strings, ...values) => {
		const launchId = client.acquire({
			origin: "kernel",
			api: "bun.shell",
			containment: "inherited",
			lifetime: "owned",
		});
		client.invoke(launchId);
		const shell = real.$(strings, ...values);
		if (shell !== null && typeof shell === "object" && "then" in shell && typeof shell.then === "function") {
			void Promise.resolve(shell).then(
				(output: unknown) => client.done(launchId, { exitCode: exitCodeOf(output) }),
				(error: unknown) => client.done(launchId, { exitCode: exitCodeOf(error) ?? 1 }),
			);
		}
		return shell;
	};
}

function exitCodeOf(value: unknown): number | undefined {
	return value !== null && typeof value === "object" && "exitCode" in value && typeof value.exitCode === "number"
		? value.exitCode
		: undefined;
}
