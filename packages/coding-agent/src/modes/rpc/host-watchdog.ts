/**
 * Opt-in supervisor-lifetime watchdog for the RPC socket host.
 *
 * A host started under the `host-lifecycle.ts` supervisor must not outlive it.
 * Catchable signals cannot carry that guarantee: `kill -9`, an OOM kill, or a
 * crashed supervisor run no JS handler, and the host is then reparented to init
 * as a permanent orphan holding its private socket forever.
 *
 * POSIX children watch the reopened stdin key pipe, or poll the recorded supervisor's
 * pid and start time when reopening is unavailable. Slot three is not trusted after
 * wrappers/re-exec. Windows and explicit embedding callers retain their fd binding.
 *
 * The bindings are unset for every other host launch, so nothing changes for
 * plain `senpi --mode rpc` runs, hosts started by hand, or embedders.
 */
import { closeSync, constants, openSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { Socket } from "node:net";
import { envValue } from "../../core/brand.ts";
import { readProcessStartTime } from "../../utils/process-identity.ts";
import { compareRecordedStart, readProcessStartTicks } from "../../utils/process-start-identity.ts";
import { recordHostCrash } from "./host-crash-record.ts";
import { HOST_DAEMON_DIR_ENV } from "./host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";
import { watchHostLifetime } from "./host-lifetime-reader.ts";

/** Inherited fd whose EOF means "the supervisor died"; set by the supervisor only. */
export const HOST_WATCH_FD_ENV = "SENPI_RPC_HOST_WATCH_FD";
/** Supervisor-owned private directory the host removes on watchdog shutdown. */
export const HOST_SCRATCH_DIR_ENV = "SENPI_RPC_HOST_SCRATCH_DIR";
/** Public socket path the supervisor bound; the host removes it ownership-checked. */
export const HOST_PUBLIC_SOCKET_ENV = "SENPI_RPC_HOST_PUBLIC_SOCKET";
/** Fallback binding when no inherited fd is available: poll this pid. */
export const HOST_WATCH_PPID_ENV = "SENPI_RPC_HOST_WATCH_PPID";
export const HOST_WATCH_PSTART_ENV = "SENPI_RPC_HOST_WATCH_PSTART";
/** Linux: the supervisor's `/proc` start ticks, compared on the boot clock (senpi#3816 review). */
export const HOST_WATCH_PSTART_TICKS_ENV = "SENPI_RPC_HOST_WATCH_PSTART_TICKS";
/**
 * POSIX: the supervisor's lifetime FIFO (senpi#3816 round 7). The supervisor holds its only writer; the host reads it,
 * and EOF - the kernel closing the last writer when the supervisor dies for any reason - ends the host.
 */
export const HOST_WATCH_LIFETIME_FIFO_ENV = "SENPI_RPC_HOST_LIFETIME_FIFO";
/** While an event binding (lifetime FIFO or reopened stdin) is armed, the identity check is one long backstop. */
export const HOST_WATCH_BACKSTOP_INTERVAL_MS = 30_000;
/** Poll cadence for the recorded-supervisor poll when it is the only binding. */
export const HOST_WATCH_PPID_INTERVAL_MS = 250;
/**
 * Poll cadence for the ppid check while the inherited pipe is armed (senpi#3738). EOF on the pipe is
 * the primary signal and arrives from kqueue/epoll at once; the ppid check then only backs it up, so
 * an idle host does not wake four times a second for a signal the pipe already delivers.
 */
export const HOST_WATCH_PPID_BACKUP_INTERVAL_MS = 5_000;
/**
 * How often the recorded supervisor's start is compared (senpi#3816 review). The liveness check runs every tick and
 * catches a dead supervisor (ESRCH); its pid can only be reused after that death, so the start comparison only has to
 * catch a death between ticks and runs rarely: every 5 s on Linux (`/proc` start ticks, nothing spawned), every 60 s
 * elsewhere (`ps`), so an idle host spawns no processes (senpi#3738). Counted in ticks, so no clock step moves it.
 */
export const HOST_WATCH_IDENTITY_INTERVAL_MS = 5_000;
/**
 * Liveness cadence when the recorded supervisor identity is the host's ONLY binding (senpi#3816 review, senpi#3738):
 * on Linux a supervised host has no stdin lifetime fd and no slot 3. One free `kill(pid, 0)` a second; supervisor
 * death is then noticed within about a second instead of 250 ms, for a quarter of the idle wakeups.
 */
export const HOST_WATCH_IDENTITY_ONLY_INTERVAL_MS = 1_000;
export const HOST_WATCH_SPAWNING_IDENTITY_INTERVAL_MS = 60_000;
export const HOST_CLEANUP_PATHS_ENV = "SENPI_RPC_HOST_CLEANUP_PATHS";

export interface HostWatchdogConfig {
	readonly fd?: number;
	readonly ppid?: number;
	readonly processStartTime?: string;
	readonly processStartTicks?: string;
	readonly lifetimeFifo?: string;
	readonly lifetimeFd?: number;
	readonly scratchDir?: string;
	readonly cleanupPaths?: readonly string[];
	readonly publicSocket?: string;
	/** Where the WATCHDOG record of this generation goes when the supervisor vanishes (senpi#2566). */
	readonly daemonDir?: string;
	readonly instanceId?: string;
	/**
	 * Runs when the watchdog fires, BEFORE `scratchDir` and `cleanupPaths` are removed. The
	 * host uses it to read state that lives inside the supervisor's private directory and
	 * that its shutdown still needs - the public-socket ownership token above all. A
	 * supervisor killed while the host is still starting up leaves that token unread, and
	 * removing the directory first would turn the public socket into an unprovable orphan.
	 */
	readonly beforeCleanup?: () => Promise<void>;
}

function parsePositiveInteger(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const parsed = Number(value.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Reads the watchdog configuration from the environment. Returns `undefined`
 * when neither binding is requested, which is the case for every host launch
 * that does not come from the lifecycle supervisor.
 */
export function readHostWatchdogConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
): HostWatchdogConfig | undefined {
	const ppid = parsePositiveInteger(env[HOST_WATCH_PPID_ENV]);
	// Slot three may have been closed/reused by a launcher. POSIX supervised children never arm it.
	const fd =
		process.platform !== "win32" && ppid !== undefined ? undefined : parsePositiveInteger(env[HOST_WATCH_FD_ENV]);
	if (fd === undefined && ppid === undefined) return undefined;
	const scratchDir = env[HOST_SCRATCH_DIR_ENV];
	const cleanupPaths = env[HOST_CLEANUP_PATHS_ENV]?.split("\n").filter(Boolean);
	const publicSocket = env[HOST_PUBLIC_SOCKET_ENV];
	const daemonDir = env[HOST_DAEMON_DIR_ENV];
	const instanceId = env[HOST_INSTANCE_ID_ENV];
	return {
		fd,
		ppid,
		...(env[HOST_WATCH_PSTART_ENV] ? { processStartTime: env[HOST_WATCH_PSTART_ENV] } : {}),
		...(env[HOST_WATCH_PSTART_TICKS_ENV] ? { processStartTicks: env[HOST_WATCH_PSTART_TICKS_ENV] } : {}),
		...(env[HOST_WATCH_LIFETIME_FIFO_ENV] ? { lifetimeFifo: env[HOST_WATCH_LIFETIME_FIFO_ENV] } : {}),
		scratchDir: scratchDir === undefined || scratchDir === "" ? undefined : scratchDir,
		cleanupPaths,
		publicSocket: publicSocket === "" ? undefined : publicSocket,
		...(daemonDir && instanceId ? { daemonDir, instanceId } : {}),
	};
}

/** Same configuration, resolved through the brand-aware env prefixes. */
export function readHostWatchdogConfigFromBrandEnv(): HostWatchdogConfig | undefined {
	// The lifecycle supervisor intentionally uses the canonical SENPI_RPC_HOST_*
	// names when spawning a child. envValue() resolves branded aliases for normal
	// launches, but must not hide the canonical variables from the supervisor
	// handoff or the lifetime binding is silently disabled.
	return readHostWatchdogConfig({
		[HOST_WATCH_FD_ENV]: process.env[HOST_WATCH_FD_ENV] ?? envValue("RPC_HOST_WATCH_FD"),
		[HOST_WATCH_PPID_ENV]: process.env[HOST_WATCH_PPID_ENV] ?? envValue("RPC_HOST_WATCH_PPID"),
		[HOST_WATCH_PSTART_ENV]: process.env[HOST_WATCH_PSTART_ENV] ?? envValue("RPC_HOST_WATCH_PSTART"),
		[HOST_WATCH_PSTART_TICKS_ENV]:
			process.env[HOST_WATCH_PSTART_TICKS_ENV] ?? envValue("RPC_HOST_WATCH_PSTART_TICKS"),
		[HOST_WATCH_LIFETIME_FIFO_ENV]: process.env[HOST_WATCH_LIFETIME_FIFO_ENV] ?? envValue("RPC_HOST_LIFETIME_FIFO"),
		[HOST_SCRATCH_DIR_ENV]: process.env[HOST_SCRATCH_DIR_ENV] ?? envValue("RPC_HOST_SCRATCH_DIR"),
		[HOST_PUBLIC_SOCKET_ENV]: process.env[HOST_PUBLIC_SOCKET_ENV] ?? envValue("RPC_HOST_PUBLIC_SOCKET"),
		[HOST_CLEANUP_PATHS_ENV]: process.env[HOST_CLEANUP_PATHS_ENV] ?? envValue("RPC_HOST_CLEANUP_PATHS"),
		[HOST_DAEMON_DIR_ENV]: process.env[HOST_DAEMON_DIR_ENV],
		[HOST_INSTANCE_ID_ENV]: process.env[HOST_INSTANCE_ID_ENV],
	});
}

/**
 * Arms the configured watchdog. `onSupervisorGone` receives the reason and is
 * expected to perform the host's normal clean shutdown; the scratch directory
 * (the supervisor's private socket directory, which no longer has an owner) is
 * removed first so nothing is left behind even if shutdown then hangs.
 *
 * Takes ownership of `config.fd`: disarming (or firing) closes it, so callers
 * must not close it themselves. Returns a disarm function; a no-op when no
 * binding is configured.
 */
export function armHostWatchdog(
	config: HostWatchdogConfig | undefined,
	onSupervisorGone: (reason: string, cleanup?: Promise<void>) => void,
): () => void {
	if (!config) return () => {};
	let stopped = false;
	let fired = false;
	const fire = (reason: string): void => {
		if (stopped || fired) return;
		fired = true;
		disarm();
		// First, before any cleanup: a supervisor that died this way runs no exit handler of its own.
		if (config.daemonDir !== undefined && config.instanceId !== undefined) {
			recordHostCrash(config.daemonDir, {
				at: new Date().toISOString(),
				uptimeMs: Math.round(process.uptime() * 1000),
				kind: "rpc-host-watchdog",
				generation: config.instanceId,
				reason,
			});
		}
		const captured = captureBeforeCleanup(config);
		if (process.platform === "win32") {
			// Arm the host shutdown fallback before attempting metadata cleanup. The
			// synchronous Win32 removal below handles the state files deterministically,
			// while the fallback still covers a named-pipe close that never completes.
			const cleanup = captured.then(() => cleanupWatchdogPaths(config));
			onSupervisorGone(reason, cleanup);
		} else {
			void captured.then(() => cleanupWatchdogPaths(config)).finally(() => onSupervisorGone(reason));
		}
	};
	const disarmers: Array<() => void> = [];
	const disarm = (): void => {
		stopped = true;
		for (const stop of disarmers.splice(0)) stop();
	};
	const ppid = config.ppid;
	let stopPpid: (() => void) | undefined;
	let ppidIntervalMs: number | undefined;
	const armPpid = (intervalMs: number): void => {
		if (stopped || ppid === undefined || ppidIntervalMs === intervalMs) return;
		stopPpid?.();
		ppidIntervalMs = intervalMs;
		stopPpid = watchPpid(ppid, { ticks: config.processStartTicks, time: config.processStartTime }, fire, intervalMs);
	};
	disarmers.push(() => stopPpid?.());
	// The poll runs only when the stdin lifetime reader is absent or failed. While a legacy inherited
	// pipe is armed it merely backs that pipe up (senpi#3738); a pipe that cannot be read (never
	// inherited, or failed later) leaves the poll as the only binding, so it goes back to the fast cadence.
	// Sole binding: a recorded supervisor identity polls at the identity-only cadence; a bare legacy ppid keeps 250 ms.
	const recordedIdentity = config.processStartTicks !== undefined || config.processStartTime !== undefined;
	const soleInterval = recordedIdentity ? HOST_WATCH_IDENTITY_ONLY_INTERVAL_MS : HOST_WATCH_PPID_INTERVAL_MS;
	let pollWanted = false;
	let pipeLive = false;
	if (config.fd !== undefined) {
		pipeLive = watchFdForEof(config.fd, fire, disarmers, () => {
			pipeLive = false;
			if (pollWanted) armPpid(soleInterval);
		});
	}
	const fallback = (): void => {
		pollWanted = true;
		armPpid(pipeLive ? HOST_WATCH_PPID_BACKUP_INTERVAL_MS : soleInterval);
	};
	// The lifetime FIFO is the event binding on every POSIX platform; a reopened stdin (macOS) stands in without one.
	const fifoFd = openLifetimeFifo(config.lifetimeFifo);
	if (fifoFd !== undefined && config.lifetimeFd !== undefined) closeSync(config.lifetimeFd);
	const lifetime = fifoFd ?? config.lifetimeFd;
	if (lifetime !== undefined) {
		try {
			const source = fifoFd === undefined ? "supervisor stdin lifetime closed" : "supervisor lifetime FIFO closed";
			disarmers.push(watchHostLifetime(lifetime, () => fire(source), fallback));
			armPpid(HOST_WATCH_BACKSTOP_INTERVAL_MS);
		} catch {
			fallback();
		}
	} else fallback();
	return disarm;
}

/**
 * Opens the read end of the supervisor's lifetime FIFO without blocking: O_NONBLOCK returns at once whether or not a
 * writer exists, and the supervisor opened its writer before it spawned this host. Any failure leaves the identity poll.
 */
function openLifetimeFifo(path: string | undefined): number | undefined {
	if (path === undefined || process.platform !== "linux") return undefined;
	try {
		return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch {
		return undefined;
	}
}

/**
 * EOF on the inherited pipe is the primary signal. The supervisor never writes
 * to it, so any readable data is ignored; only close matters. An fd that cannot
 * be opened (never inherited) leaves the binding inert rather than killing a
 * healthy host.
 *
 * The pipe is read through a net.Socket rather than a file stream because the read has to live
 * on the EVENT LOOP, not in libuv's thread pool. A thread-pool read blocks in `read(2)` until the
 * supervisor dies, and `process.exit()` joins the thread pool before it terminates - so a host
 * that decides to exit on its own (an idle exit, or the park-everything drain of a generation
 * handoff) would hang in exit until something killed it. With a socket the same EOF arrives from
 * kqueue/epoll and nothing holds the exit.
 */
function watchFdForEof(
	fd: number,
	fire: (reason: string) => void,
	disarmers: Array<() => void>,
	onUnavailable: () => void,
): boolean {
	let stream: Socket;
	let streamFailed = false;
	let fired = false;
	const fireOnce = (reason: string): void => {
		if (fired) return;
		fired = true;
		fire(reason);
	};
	try {
		// The watchdog owns this inherited read end; destroying the socket releases it.
		stream = new Socket({ fd, readable: true, writable: false });
	} catch {
		return false;
	}
	stream.resume();
	const onEnd = (): void => fireOnce(`supervisor pipe fd ${fd} closed`);
	const onClose = (): void => {
		if (!streamFailed) onEnd();
	};
	const onError = (): void => {
		streamFailed = true;
		onUnavailable();
	};
	stream.once("end", onEnd);
	// Win32 pipe teardown may report close without end; POSIX invalid-fd close is
	// not supervisor death and remains inert.
	if (process.platform === "win32") stream.once("close", onClose);
	stream.once("error", onError);
	disarmers.push(() => {
		stream.off("end", onEnd);
		stream.off("close", onClose);
		stream.off("error", onError);
		stream.destroy();
	});
	return true;
}

/**
 * Poll only the recorded supervisor, never process.ppid (a wrapper may be the parent). Every tick is a free
 * `kill(pid, 0)`: ESRCH is death. The recorded start is compared rarely, on one clock per platform
 * (`compareRecordedStart`); only an observed change is death, and an unreadable or missing identity is unknown.
 */
function watchPpid(
	supervisorPid: number,
	recorded: { readonly ticks?: string; readonly time?: string },
	fire: (reason: string) => void,
	intervalMs: number,
): () => void {
	// Tests and embedders may bind the watchdog to this process itself; that
	// is a valid live binding rather than evidence of supervisor loss.
	if (supervisorPid === process.pid) return () => {};
	const linux = process.platform === "linux";
	const comparable = linux ? recorded.ticks !== undefined : recorded.time !== undefined;
	const identityEveryTicks = Math.max(
		1,
		Math.round((linux ? HOST_WATCH_IDENTITY_INTERVAL_MS : HOST_WATCH_SPAWNING_IDENTITY_INTERVAL_MS) / intervalMs),
	);
	const probe = {
		ticks: (pid: number) => readProcessStartTicks(pid),
		time: (pid: number) => readProcessStartTime(pid, process.platform, 1000),
	};
	let ticks = 0;
	let stopped = false;
	let probing = false;
	const timer = setInterval(() => {
		if (stopped) return;
		if (!processAlive(supervisorPid)) {
			fire(`supervisor pid ${supervisorPid} is gone`);
			return;
		}
		ticks += 1;
		if (!comparable || probing || ticks % identityEveryTicks !== 0) return;
		probing = true;
		void compareRecordedStart(supervisorPid, recorded, process.platform, probe)
			.then(
				(result) => {
					if (!stopped && result === "changed") fire(`supervisor pid ${supervisorPid} start time changed`);
				},
				// Permission, timeout and probe failures are unknown, never death.
				() => {},
			)
			.finally(() => {
				probing = false;
			});
	}, intervalMs);
	timer.unref?.();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH");
	}
}

// A failing capture must never block the cleanup or the shutdown it precedes.
function captureBeforeCleanup(config: HostWatchdogConfig): Promise<void> {
	if (config.beforeCleanup === undefined) return Promise.resolve();
	return Promise.resolve()
		.then(config.beforeCleanup)
		.catch(() => undefined);
}

/**
 * Removes the cleanup paths one at a time, in list order, on every platform: the supervisor puts
 * the registration pointer last (host-cleanup-paths.ts), and it must not vanish before the state
 * it describes (senpi#2241).
 */
export async function cleanupWatchdogPaths(config: HostWatchdogConfig): Promise<void> {
	const paths = [...(config.cleanupPaths ?? []), ...(config.scratchDir ? [config.scratchDir] : [])];
	for (const path of paths) {
		try {
			if (process.platform === "win32")
				rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			else await rm(path, { recursive: true, force: true });
		} catch {}
	}
}
