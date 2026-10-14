import { existsSync } from "node:fs";
import { access, chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";
import type { CreateAgentSessionRuntimeFactory } from "../../core/agent-session-runtime.ts";
import { envValue } from "../../core/brand.ts";
import { HostMcpRegistry } from "../../core/extensions/builtin/mcp/host-registry.ts";
import type { SessionContext } from "../../core/extensions/types.ts";
import {
	flushRawStdout,
	takeOverStdout,
	waitForRawStdoutBackpressure,
	writeRawStdout,
} from "../../core/output-guard.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import { startHostChildReaper } from "./child-reaper.ts";
import type { RpcConnectionSink } from "./connection-handler.ts";
import { parseClientCapabilities } from "./custom-capability.ts";
import { ClientOccupancy } from "./host-client-occupancy.ts";
import { HostCoreGate, type HostCoreHooks } from "./host-core-gate.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { GENERATION_HANDOFF_CAPABILITY } from "./host-decision.ts";
import {
	clearHandoverParkedSession,
	dropHandoverParkedSessionIfFileGone,
	type HandoverParkedEntry,
	readHandoverParkedSessions,
} from "./host-handover-parked.ts";
import { performIdleHandover } from "./host-handover-wire.ts";
import { EXPECTED_RUNTIME_BUILD_ID_ENV } from "./host-idle-handover.ts";
import { type HostIdleOverrides, RPC_CLOSE_GRACE_MS_ENV, resolveHostIdlePolicy } from "./host-idle-policy.ts";
import { parseIdleExitMs } from "./host-lifecycle.ts";
import { createZeroSessionTrim, startHostObservers } from "./host-observers.ts";
import { runAsHostGenerationProcess } from "./host-process-role.ts";
import { createEndpointReservations } from "./host-reservations.ts";
import { armHostWatchdog, readHostWatchdogConfigFromBrandEnv } from "./host-watchdog.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "./jsonl.ts";
import { hostGeneration, hostInstanceId, protocolIdentity } from "./protocol-identity.ts";
import { rpcCommandShapeError } from "./rpc-input-validation.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { computeRuntimeBuildId, RUNTIME_IDENTITY_HANDOVER_CAPABILITY } from "./runtime-build-id.ts";
import { type RpcBindingFactory, SessionCommandRouter } from "./session-command-router.ts";
import { SessionEventWriter } from "./session-event-writer.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import { RpcSessionRegistry, RpcSessionRegistryError } from "./session-registry.ts";
import {
	PUBLIC_SOCKET_IDENTITY_FILE,
	readSocketIdentityFile,
	type SocketFileIdentity,
	shieldSocketDuringClose,
	socketEntryReplaced,
	statSocketIdentity,
	unlinkOwnedSocket,
	waitForSocketIdentityFile,
} from "./socket-ownership.ts";
import { socketSink } from "./socket-sink.ts";
import {
	authenticateSocket,
	ensureSocketSecret,
	resolveSocketTransportAddress,
	SOCKET_SECRET_FILE_ENV,
	socketSecretPath,
} from "./socket-transport.ts";
import { WorkerSessionRegistry } from "./worker-session-registry.ts";

export interface MultiSessionHostOptions {
	agentDir: string;
	createRuntime: CreateAgentSessionRuntimeFactory;
	workerConfiguration?: CliRuntimeConfiguration;
	cwd: string;
	permissionPreset?: string;
	creationModel?: { provider: string; modelId: string };
	initialThinkingLevel?: string;
	listen?: string;
	/** Test seam: defaults to the real shared-session binding. */
	createBinding?: RpcBindingFactory;
}

export {
	DEFAULT_HOST_EMPTY_EXIT_MS,
	DEFAULT_SESSION_IDLE_EVICTION_MS,
	RPC_HOST_EMPTY_EXIT_MS_ENV,
	RPC_SESSION_IDLE_EVICTION_MS_ENV,
	resolveHostIdlePolicy,
} from "./host-idle-policy.ts";

/** Win32 named-pipe close can leave libuv's server callback pending after handles are destroyed. */
const WINDOWS_SHUTDOWN_HARD_EXIT_MS = 2_000;

interface Connection {
	readonly id: string;
	readonly sink: RpcConnectionSink;
	readonly detach: () => void;
	readonly close: () => void;
}

/**
 * Socket agent events are delivered only to connections attached to their
 * session, tagged with its routing sessionId. Content-free session lifecycle
 * events remain visible to every connection. Responses and extension UI
 * requests remain requester-only; foreign observation uses attach-on-open.
 */
/**
 * senpi#3282: a successor host reopens exactly the set its predecessor held resident and parked
 * with `handoff_parked`, restoring it with the same durable id and `retain_on_disconnect`. An
 * entry is removed from the record only after a successful reopen (crash-safe, at most once); an
 * entry whose session file is gone is logged and dropped. Runs once at host startup.
 */
async function reopenHandoverParkedSessions(
	registry: Pick<RpcSessionRegistry, "openSession"> & { readonly size?: number },
	agentDir: string,
	socket: string,
	holder?: { readonly hostInstance: string; readonly hostSocket?: string },
): Promise<void> {
	const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
	// The predecessor parks its retained sessions AFTER this generation binds the public socket (its
	// drain fires on detecting supersession), so the record is not necessarily present at startup,
	// and a session still busy at the drain start parks only after its turn settles. Returning on the
	// first empty read would drop those. Keep watching until the record has stayed empty for a
	// sustained streak - the drain has finished writing by then - bounded by the window. Entries are
	// removed only after a successful reopen (crash-safe, at most once, never lost).
	//
	// The empty-streak early-exit only applies once a park has actually been seen: under load the
	// predecessor's drain can be delayed past the whole quiet streak while it has not written a
	// single entry yet, and returning then would skip a park that lands late (senpi#3282 review).
	// Before the first entry arrives, only the budget ends the watch. The record persists until a
	// successful reopen consumes it, so the watch can afford a generous budget: a predecessor whose
	// event loop is starved by parallel hosts still parks eventually, and the entry is waiting when
	// it does. Once a park has been seen and the record has stayed empty for the quiet streak, the
	// drain is finished and the watch returns early.
	const deadline = Date.now() + HANDOVER_PARKED_REOPEN_BUDGET_MS;
	const reopenAttempts = new Map<string, number>();
	const heldPolls = new Map<string, number>();
	let emptyStreak = 0;
	let sawAnyPark = false;
	for (;;) {
		const parked = await readHandoverParkedSessions(daemonDir);
		for (const entry of parked) {
			sawAnyPark = true;
			await reopenOne(daemonDir, registry, entry, reopenAttempts, heldPolls, holder);
		}
		const remaining = (await readHandoverParkedSessions(daemonDir)).length;
		emptyStreak = remaining === 0 ? emptyStreak + 1 : 0;
		if (sawAnyPark && emptyStreak >= HANDOVER_PARKED_REOPEN_QUIET_STREAK) return;
		if (Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, HANDOVER_PARKED_REOPEN_POLL_MS));
	}
}

async function reopenOne(
	daemonDir: string,
	registry: Pick<RpcSessionRegistry, "openSession">,
	entry: HandoverParkedEntry,
	attempts: Map<string, number>,
	heldPolls?: Map<string, number>,
	holder?: { readonly hostInstance: string; readonly hostSocket?: string },
): Promise<void> {
	await dropHandoverParkedSessionIfFileGone(daemonDir, entry.sessionPath);
	if (!existsSync(entry.sessionPath)) {
		process.stderr.write(`senpi rpc successor dropped a parked session whose file is gone: ${entry.sessionPath}\n`);
		return;
	}
	try {
		await registry.openSession(
			{
				...(entry.cwd !== undefined ? { cwd: entry.cwd } : { cwd: process.cwd() }),
				sessionPath: entry.sessionPath,
				...(holder !== undefined
					? {
							holderEndpoint: {
								host_instance: holder.hostInstance,
								...(holder.hostSocket !== undefined ? { host_socket: holder.hostSocket } : {}),
							},
						}
					: {}),
				...(entry.durableSessionId !== undefined ? { durableSessionId: entry.durableSessionId } : {}),
				...(entry.model !== undefined ? { creationModel: entry.model } : {}),
				...(entry.thinkingLevel !== undefined ? { initialThinkingLevel: entry.thinkingLevel } : {}),
			},
			{ retainOnDisconnect: entry.retainOnDisconnect },
		);
		await clearHandoverParkedSession(daemonDir, entry.sessionPath);
	} catch (cause) {
		// A `session_path_in_use` refusal means the predecessor still holds the path's cross-generation
		// claim (its drain has not released it yet): the holder is alive, so the park is not failing -
		// it is waiting. It is retried on the next poll, bounded only by the watch budget, and it is
		// NOT counted toward the attempt cap. Only a genuine failure consumes an attempt: if held
		// refusals also counted, ~2s of holding would push the count past the cap, and the first real
		// failure after the predecessor releases the path would drop the entry at once (M1).
		const heldByPredecessor = cause instanceof RpcSessionRegistryError && cause.code === "session_path_in_use";
		if (heldByPredecessor) {
			// Throttle the hold log: a slow drain can hold the path for the whole budget, and a line
			// every 250 ms is ~480 lines of noise. Log the first hold, then about once every 10 s.
			const polls = (heldPolls?.get(entry.sessionPath) ?? 0) + 1;
			heldPolls?.set(entry.sessionPath, polls);
			if (polls === 1 || polls % 40 === 0)
				process.stderr.write(
					`senpi rpc successor reopen parked session ${entry.sessionPath} waiting on the holder: ${String(cause)}\n`,
				);
			return;
		}
		const tried = (attempts.get(entry.sessionPath) ?? 0) + 1;
		attempts.set(entry.sessionPath, tried);
		if (tried >= HANDOVER_PARKED_REOPEN_MAX_ATTEMPTS) {
			process.stderr.write(
				`senpi rpc successor gave up reopening parked session ${entry.sessionPath} after ${tried} attempts: ${String(cause)}\n`,
			);
			await clearHandoverParkedSession(daemonDir, entry.sessionPath);
			return;
		}
		process.stderr.write(`senpi rpc successor reopen parked session ${entry.sessionPath} failed: ${String(cause)}\n`);
	}
}

// The watch budget must outlast a heavily loaded drain: a predecessor whose event loop is blocked
// (parallel hosts, a busy turn settling) can take tens of seconds to write its park after this
// generation binds. The record persists until a successful reopen consumes it, so a generous
// budget is safe: the watch is a background task that never blocks readiness, and it returns early
// once the record has been drained and stayed empty for the quiet streak.
const HANDOVER_PARKED_REOPEN_BUDGET_MS = 120_000;
const HANDOVER_PARKED_REOPEN_POLL_MS = 250;
const HANDOVER_PARKED_REOPEN_MAX_ATTEMPTS = 8;
const HANDOVER_PARKED_REOPEN_QUIET_STREAK = 8;

export async function runMultiSessionHost(options: MultiSessionHostOptions): Promise<never> {
	return runAsHostGenerationProcess(() =>
		options.listen === undefined || options.listen === "stdio://"
			? runStdioHost(options)
			: runSocketHost(options, resolveSocketPath(options.listen, options.agentDir)),
	);
}

export function createHostCore(
	options: MultiSessionHostOptions,
	writer: SessionEventWriter,
	capabilities = parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")),
	idle: HostIdleOverrides = {},
	hostContext?: SessionContext,
	hooks: HostCoreHooks = {},
) {
	const policy = resolveHostIdlePolicy(process.env, idle);
	const endpointSocket = publicEndpointSocket(options);
	const pathReservations = createEndpointReservations({
		agentDir: options.agentDir,
		socket: listenSocketPath(options),
		instanceId: hostInstanceId(),
		publicSocket: hostContext?.host_socket,
		onFailure: hostLog,
	});
	const registry = options.workerConfiguration
		? new WorkerSessionRegistry({
				configuration: options.workerConfiguration,
				now: policy.now,
				closeGraceMs: idle.closeGraceMs ?? parseIdleExitMs(process.env[RPC_CLOSE_GRACE_MS_ENV]) ?? 10_000,
				pathReservations,
			})
		: new RpcSessionRegistry({
				agentDir: options.agentDir,
				createRuntime: options.createRuntime,
				mcpRegistry: new HostMcpRegistry(),
				now: policy.now,
				closeGraceMs: idle.closeGraceMs ?? parseIdleExitMs(process.env[RPC_CLOSE_GRACE_MS_ENV]) ?? 10_000,
				// Two generations of this daemon can be alive at once during a handoff; the claims
				// they publish here are what keeps them off one session file.
				...(hooks.onSessionCountChange ? { onSizeChange: hooks.onSessionCountChange } : {}),
				pathReservations,
			});
	const router = new SessionCommandRouter(
		registry,
		writer,
		hostContext ? { ...options, hostContext } : options,
		options.createBinding,
		{ capabilities },
		{
			now: policy.now,
			idleEvictionMs: policy.idleEvictionMs,
			emptyExitMs: policy.emptyExitMs,
			onEmptyExit: idle.onEmptyExit,
			onHandoffParked: idle.onHandoffParked,
			...(endpointSocket === undefined
				? {}
				: {
						handoverParkedDir: createHostDaemonPaths({
							socket: endpointSocket,
							agentDir: options.agentDir,
						}).dir,
					}),
			canExitWhenEmpty: idle.canExitWhenEmpty,
		},
	);
	if (endpointSocket !== undefined)
		reopenHandoverParkedSessions(registry, options.agentDir, endpointSocket, {
			hostInstance: hostInstanceId(),
			hostSocket: endpointSocket,
		}).catch((cause: unknown) => {
			process.stderr.write(`senpi rpc successor reopen parked set failed: ${String(cause)}\n`);
		});
	const gate = new HostCoreGate(registry, (command) => router.handle(command), hooks);
	const handle = async (line: string): Promise<void> => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch (cause) {
			await writer.enqueueControl(parseError(`Failed to parse command: ${errorMessage(cause)}`));
			return;
		}
		if (await gate.intercept(parsed, (answer) => writer.enqueueControl(answer))) return;
		const shapeError = rpcCommandShapeError(parsed);
		if (shapeError) {
			await writer.enqueueControl(parseError(shapeError));
			return;
		}
		const response = await gate.dispatch(parsed as RpcCommand);
		if (response) await writer.enqueueControl(response);
	};
	return { router, handle, handover: gate.handover, handoverAnswered: () => gate.answered() };
}

/** Plain-stdio host with no eagerly-created AgentSessionRuntime. */
async function runStdioHost(options: MultiSessionHostOptions): Promise<never> {
	takeOverStdout();
	const sink: RpcConnectionSink = { writeRaw: writeRawStdout, waitForBackpressure: waitForRawStdoutBackpressure };
	const writer = new SessionEventWriter(sink.writeRaw, sink.waitForBackpressure);
	// An empty host (no session ever opened, or all closed) must not stay resident
	// forever: exit through the normal shutdown path once the window elapses.
	const runtimeBuildId = await startupRuntimeBuildId();
	const trim = createZeroSessionTrim(writer, () => router.sessionCount);
	const { router, handle } = createHostCore(
		options,
		writer,
		undefined,
		{ onEmptyExit: () => void shutdown(0) },
		undefined,
		{
			...(runtimeBuildId === undefined ? {} : { runtimeBuildId }),
			onSessionCountChange: (size) => trim.observe(size),
		},
	);
	const observers = startHostObservers(router, writer, { trim });
	let shuttingDown = false;
	const shutdown = async (exitCode = 0): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		observers.stop();
		detach();
		await router.dispose();
		await writer.flush();
		await flushRawStdout();
		process.exit(exitCode);
	};
	const onEnd = () => void shutdown();
	process.stdin.on("end", onEnd);
	const reportInputFailure = (cause: unknown): void => {
		process.stderr.write(`senpi rpc stdio request failed: ${errorMessage(cause)}\n`);
	};
	const detachReader = attachJsonlLineReader(process.stdin, (line) => void handle(line).catch(reportInputFailure), {
		maxLineLength: MAX_RPC_LINE_CHARACTERS,
		onOversizedLine: () => void writer.enqueueControl(parseError(oversizedLineError())).catch(reportInputFailure),
	});
	const detach = () => {
		detachReader();
		process.stdin.off("end", onEnd);
	};
	registerShutdownSignals(shutdown);
	return new Promise(() => {});
}

async function runSocketHost(options: MultiSessionHostOptions, socketPath: string): Promise<never> {
	await prepareSocketPath(socketPath);
	const writer = new SessionEventWriter(() => {});
	const connections = new Map<string, Connection>();
	// The supervisor's rule for which clients hold a host open (host-client-occupancy.ts): a
	// connection that has only sent observing reads (`status`) is not occupancy.
	const occupancy = new ClientOccupancy(() => {});
	let draining = false;
	let handoffAnnounced = false;
	const hostContext = hostSessionContext(socketPath);
	const runtimeBuildId = await startupRuntimeBuildId();
	const expected = process.env[EXPECTED_RUNTIME_BUILD_ID_ENV];
	if (expected !== undefined && expected !== runtimeBuildId) {
		// An idle handover started this host for a runtime it does not run (the files changed since the
		// request). Exiting before it listens leaves the predecessor serving, and the handover blocked.
		hostLog(`runtime ${runtimeBuildId ?? "unreadable"} is not the handover target ${expected}; exiting`);
		process.exit(1);
	}
	const canHandOver = runtimeBuildId !== undefined && process.platform !== "win32";
	const trim = createZeroSessionTrim(writer, () => router.sessionCount);
	const { router, handle, handover, handoverAnswered } = createHostCore(
		options,
		writer,
		[
			...parseClientCapabilities(envValue("RPC_CLIENT_CAPABILITIES")),
			// A socket host installs the SIGUSR1 drain below, so it can be handed off to a newer
			// generation instead of being killed. A host that does not advertise this is never
			// signalled - SIGUSR1 would simply terminate it, sessions and all.
			GENERATION_HANDOFF_CAPABILITY,
			// The host reports the runtime it loaded and can hand over at its next idle point.
			...(canHandOver ? [RUNTIME_IDENTITY_HANDOVER_CAPABILITY] : []),
		],
		// Supervised hosts idle-exit via the supervisor, but a socket host that
		// outlives its supervisor (or is started bare) still self-exits when empty.
		// A connected client counts as occupancy even with no session open: exiting
		// under it would drop its socket and read as a crash to the supervisor. Only an
		// OBSERVER does not - one whose every request so far was an `observe: true` read.
		// While DRAINING the opposite is true: the successor generation owns the socket, so a
		// sessionless connection must not hold this host open.
		{
			onEmptyExit: () => void shutdown(0),
			canExitWhenEmpty: () => draining || (occupancy.attachedCount === 0 && occupancy.unclassifiedCount === 0),
			onHandoffParked: async (ids) => {
				await Promise.all(
					ids.map(async (id) => {
						await writer.flushConnection(id);
						connections.get(id)?.close();
					}),
				);
			},
		},
		hostContext,
		{
			onSessionCountChange: (size) => trim.observe(size),
			...(runtimeBuildId !== undefined && { runtimeBuildId }),
			...(canHandOver && {
				handover: {
					identity: () => ({
						instanceId: hostInstanceId(),
						generation: hostGeneration(process.env),
						runtimeBuildId,
					}),
					perform: (request) =>
						performIdleHandover({
							request,
							socket: readHostWatchdogConfigFromBrandEnv()?.publicSocket ?? socketPath,
							agentDir: options.agentDir,
						}),
					log: hostLog,
				},
			}),
		},
	);
	const observers = startHostObservers(router, writer, {
		trim,
		// The shape #1893 measured: gigabytes resident with `sessions.total 0`. Say it once, and when
		// this generation no longer owns the endpoint, leave - nobody can reach it to ask.
		onIdlePressure: ({ footprintMb, measure, rssMb }) => {
			hostLog(`memory pressure with no sessions: footprintMb=${footprintMb} (${measure}) rssMb=${rssMb}`);
			void endpointSuperseded().then((superseded) => {
				if (superseded) drainForHandoff();
			}, noop);
		},
	});
	let nextConnection = 0;
	let shuttingDown = false;
	const secret =
		process.platform === "win32"
			? await ensureSocketSecret(process.env[SOCKET_SECRET_FILE_ENV] ?? socketSecretPath(socketPath))
			: undefined;
	const watchdogConfig = readHostWatchdogConfigFromBrandEnv();
	// This host's OWN copy of the crash-path cleanup list. A drain empties it: once a successor
	// generation is registered, the daemon state files under those paths describe the successor,
	// and a crash of this (already replaced) host must not take them with it.
	const crashCleanupPaths = [...(watchdogConfig?.cleanupPaths ?? [])];
	// Crash-path ownership for the supervisor's PUBLIC socket: the supervisor
	// records the identity of the entry it bound (inside its private scratch
	// directory, which no replacement supervisor writes) right after its listen,
	// and this host removes that path only while the identity still matches. A
	// blind path removal here would unlink a newer host's freshly published
	// entry after a takeover - the startup path already refuses to touch a
	// socket owned by a live server; teardown follows the same rule.
	const supervisorPublicSocketPath =
		process.platform === "win32" || socketPath.startsWith("\0") ? undefined : watchdogConfig?.publicSocket;
	const supervisorPublicOwnerFile =
		supervisorPublicSocketPath && watchdogConfig?.scratchDir
			? join(watchdogConfig.scratchDir, PUBLIC_SOCKET_IDENTITY_FILE)
			: undefined;
	let boundIdentity: SocketFileIdentity | undefined;
	let supervisorPublicIdentity: SocketFileIdentity | undefined;
	const server = createServer((socket) => {
		const accept = (): void => {
			if (draining || shuttingDown) {
				socket.destroy();
				return;
			}
			const id = `socket-${++nextConnection}`;
			const sink = socketSink(socket);
			writer.registerConnection(id, sink);
			occupancy.admit(socket);
			const detachReader = attachJsonlLineReader(
				socket,
				(line) => {
					// Do not serialize awaited commands: extension_ui_response and other
					// re-entrant frames must be able to resolve a command already awaiting them.
					void writer
						.withConnection(id, () => handle(line))
						.catch((cause) => {
							process.stderr.write(`senpi rpc connection ${id} failed: ${errorMessage(cause)}\n`);
						});
				},
				{
					maxLineLength: MAX_RPC_LINE_CHARACTERS,
					onOversizedLine: () => {
						void writer
							.withConnection(id, () => writer.enqueueControl(parseError(oversizedLineError())))
							.catch((cause) =>
								process.stderr.write(`senpi rpc connection ${id} failed: ${errorMessage(cause)}\n`),
							);
					},
				},
			);
			let detached = false;
			const detach = () => {
				if (detached) return;
				detached = true;
				detachReader();
				writer.unregisterConnection(id);
				connections.delete(id);
				occupancy.release(socket);
				// A socket that dies without close_session still owns its sessions' attachments
				// and path reservations. Release them on the command chain so this runs after any
				// in-flight command for this connection settles, otherwise the path stays pinned
				// by a runtime whose client is gone and later resumes attach to that orphan.
				void router.releaseConnection(id).catch((cause) => {
					process.stderr.write(`senpi rpc connection ${id} release failed: ${errorMessage(cause)}\n`);
				});
			};
			connections.set(id, { id, sink, detach, close: () => socket.destroy() });
			socket.once("close", detach);
			socket.once("error", () => detach());
		};
		if (secret) authenticateSocket(socket, secret, accept);
		else accept();
	});
	server.on("error", (cause) => {
		if (!shuttingDown) process.stderr.write(`senpi rpc socket listener failed: ${errorMessage(cause)}\n`);
	});
	// Long-lived hosts outlive many session workers, and a terminated worker thread
	// takes its children's exit watchers with it (measured: every spawn API leaks
	// that way). The reaper claims those abandoned children; it never touches one a
	// live thread could still be waiting for.
	const stopChildReaper = await startHostChildReaper(hostLog);
	const shutdown = async (exitCode = 0, watchdogCleanup?: Promise<void>): Promise<never> => {
		if (shuttingDown) process.exit(exitCode);
		shuttingDown = true;
		observers.stop();
		handover?.dispose();
		stopChildReaper();
		// A handover that completed at once drains this host; its caller still gets the answer.
		await handoverAnswered();
		// On Windows, destroying named-pipe sockets does not always make libuv's
		// server.close callback fire: connected pipe instances can remain in the
		// kernel after the JavaScript handles are destroyed. Keep the normal drain
		// path, but never let that platform-specific close stall orphan the host.
		try {
			// Dispose while connections are still registered so `session_closed`
			// `{ reason: "host_shutdown" }` reaches clients before the sockets die.
			await router.dispose();
			await writer.flush();
			for (const connection of connections.values()) {
				connection.detach();
				connection.close();
			}
			// libuv unlinks the bound NAME when the listening handle closes - which
			// would delete a newer host's entry renamed over this path. Shield the
			// current entry for the close, then let the ownership check decide.
			await shieldSocketDuringClose(socketPath, () =>
				process.platform === "win32"
					? Promise.race([closeServer(server), delay(WINDOWS_SHUTDOWN_HARD_EXIT_MS)])
					: closeServer(server),
			);
			// Ownership-checked: unlink only the entry THIS process bound. After a
			// takeover renamed a newer host's socket over the same path, the
			// identity no longer matches and the replacement stays published.
			await unlinkOwnedSocket(socketPath, boundIdentity, hostLog);
			if (supervisorPublicSocketPath) {
				await unlinkOwnedSocket(supervisorPublicSocketPath, supervisorPublicIdentity, hostLog);
			}
			if (watchdogCleanup) await watchdogCleanup;
		} finally {
			// Explicitly terminate after every shutdown trigger. Windows named-pipe
			// handles are not fully controllable from JS, and an unresolved cleanup
			// must not leave this daemon or its public endpoint alive.
			process.exit(exitCode);
		}
	};
	/**
	 * Announce through the record writer, never inside the supervisor's raw byte proxy. This
	 * preserves JSONL framing and FIFO before parking, including when a record spans proxy reads.
	 * Active turns/requests keep running; durable wake-source holds resume on reopen.
	 */
	const drainForHandoff = (): void => {
		if (shuttingDown) return;
		if (draining) {
			if (handoffAnnounced) router.beginDrain();
			return;
		}
		draining = true;
		crashCleanupPaths.length = 0;
		hostLog("draining for a generation handoff");
		void endpointSuperseded()
			.then((superseded) => {
				writer.broadcastHostRecord({
					type: "host_superseded",
					instanceId: hostInstanceId(),
					generation: hostGeneration(process.env),
					successor: superseded ? { socket: supervisorPublicSocketPath ?? socketPath } : null,
				});
			})
			.catch((cause: unknown) => {
				hostLog(`handoff announcement failed: ${String(cause)}`);
			})
			// A failed announcement still drains: parking is what lets this generation exit (senpi#2285).
			.finally(() => {
				handoffAnnounced = true;
				router.beginDrain();
			});
	};
	/**
	 * Whether the endpoint this host serves is held by another socket entry now. A supervised host
	 * answers for the PUBLIC path its supervisor bound - its own listener is a private hop nobody
	 * replaces - and a bare host for the path it bound itself.
	 */
	const endpointSuperseded = (): Promise<boolean> =>
		supervisorPublicSocketPath === undefined
			? socketEntryReplaced(socketPath, boundIdentity)
			: socketEntryReplaced(supervisorPublicSocketPath, supervisorPublicIdentity);
	registerShutdownSignals(shutdown);
	if (process.platform !== "win32") process.on("SIGUSR1", drainForHandoff);
	// Arm before listen: a supervisor death during the listen transition must
	// still close the child and clean its private endpoint.
	const watchdog =
		watchdogConfig && supervisorPublicOwnerFile
			? {
					...watchdogConfig,
					cleanupPaths: crashCleanupPaths,
					// The supervisor may die while this host is still waiting for the token
					// below; read it before the watchdog removes the scratch directory, or the
					// shutdown's ownership check has nothing to prove with and leaves the
					// public socket behind.
					beforeCleanup: async () => {
						supervisorPublicIdentity ??= await readSocketIdentityFile(supervisorPublicOwnerFile);
					},
				}
			: watchdogConfig && { ...watchdogConfig, cleanupPaths: crashCleanupPaths };
	armHostWatchdog(watchdog, (reason, cleanup) => {
		process.stderr.write(`senpi rpc host: ${reason}; shutting down\n`);
		// Enter shutdown before killing session-owned child processes. The Windows
		// tree killer is synchronous, while the shutdown fallback must be armed
		// before any such cleanup can delay the event loop.
		void shutdown(0, cleanup);
		setImmediate(killTrackedDetachedChildren);
	});
	boundIdentity = await listen(server, socketPath, secret);
	if (supervisorPublicOwnerFile) {
		// The supervisor publishes its public-socket token after this internal
		// listener is ready, so a short bounded wait keeps the lifecycles in step
		// without delaying unsupervised hosts.
		supervisorPublicIdentity = await waitForSocketIdentityFile(supervisorPublicOwnerFile);
	}
	process.stderr.write(`senpi rpc listening on ${formatSocketAddress(socketPath)}\n`);

	// Opt-in only: set by the lifecycle supervisor so this host can never outlive
	// it, including when the supervisor is SIGKILLed and runs no handler at all.
	return new Promise(() => {});
}

/**
 * The runtime this process loaded, digested once before it serves anything. A runtime that cannot
 * be read leaves the host unverified (no `runtimeBuildId`, no handover capability) instead of
 * keeping it from starting.
 */
async function startupRuntimeBuildId(): Promise<string | undefined> {
	try {
		return await computeRuntimeBuildId({ profile: protocolIdentity().launch_profile.core });
	} catch (cause) {
		hostLog(`runtime identity unreadable: ${errorMessage(cause)}`);
		return undefined;
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function noop(): void {}

function parseError(error: string): RpcResponse {
	return { type: "response", command: "parse", success: false, error };
}

function oversizedLineError(): string {
	return `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`;
}

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The identity every session on this socket host carries in its context: `host_socket`, the PUBLIC
 * endpoint clients address (the supervisor's path for a supervised host, whose own listener is a
 * private hop; the bound path for a bare one), realpath-canonicalized so it compares equal however
 * the path was spelled; and `host_instance`, this generation. The endpoint is stable across handoffs,
 * the instance is not. The FIRST generation runs this before its supervisor has created the socket's
 * directory, a successor after, so the directory is canonicalized through its deepest existing
 * ancestor: both then stamp the same spelling. `host_socket` is omitted where no public path exists
 * (abstract sockets, a supervised win32 host, whose supervisor publishes none).
 */
function hostSessionContext(socketPath: string): SessionContext {
	const supervised = readHostWatchdogConfigFromBrandEnv();
	const endpoint = supervised === undefined ? socketPath : supervised.publicSocket;
	if (endpoint === undefined || endpoint.startsWith("\0")) return { host_instance: hostInstanceId() };
	const directory = canonicalSessionPath(dirname(endpoint));
	return { host_socket: join(directory, basename(endpoint)), host_instance: hostInstanceId() };
}

/** The endpoint this host listens on, or nothing when it speaks stdio and shares no socket. */
function listenSocketPath(options: MultiSessionHostOptions): string | undefined {
	if (options.listen === undefined || options.listen === "stdio://") return undefined;
	return resolveSocketPath(options.listen, options.agentDir);
}

/**
 * The PUBLIC endpoint clients address, matching `hostSessionContext`: a supervised host's own
 * listener is a private hop, so the daemon-directory key must come from the supervisor's public
 * socket or every generation hashes a different directory (senpi#3282). Bare hosts bind the path.
 */
function publicEndpointSocket(options: MultiSessionHostOptions): string | undefined {
	const supervised = readHostWatchdogConfigFromBrandEnv();
	if (supervised !== undefined) return supervised.publicSocket;
	return listenSocketPath(options);
}

function resolveSocketPath(value: string, agentDir: string): string {
	if (value === "unix://") return join(agentDir, "rpc", "rpc.sock");
	if (value.startsWith("unix://")) {
		const path = value.slice("unix://".length);
		if (path.length === 0) return join(agentDir, "rpc", "rpc.sock");
		if (path.startsWith("@") && process.platform === "linux") return `\0${path.slice(1)}`;
		return path;
	}
	return value;
}

function formatSocketAddress(socketPath: string): string {
	return socketPath.startsWith("\0") ? `unix://@${socketPath.slice(1)}` : `unix://${socketPath}`;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
	if (process.platform === "win32" || socketPath.startsWith("\0")) return;
	await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
	try {
		await access(socketPath);
	} catch (cause) {
		if (isNodeErrorCode(cause, "ENOENT")) return;
		throw cause;
	}
	if (await probeSocket(socketPath)) throw new Error(`${socketPath}: address already in use by a live server.`);
	await unlink(socketPath);
}

function probeSocket(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform));
		const settle = (live: boolean) => {
			socket.destroy();
			resolve(live);
		};
		socket.once("connect", () => settle(true));
		socket.once("error", () => settle(false));
		socket.setTimeout(1_000, () => settle(false));
	});
}

function listen(server: Server, socketPath: string, secret?: Uint8Array): Promise<SocketFileIdentity | undefined> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(resolveSocketTransportAddress(socketPath, process.platform, secret), async () => {
			server.off("error", reject);
			try {
				if (process.platform !== "win32" && !socketPath.startsWith("\0")) {
					await chmod(socketPath, 0o600);
					// Record which filesystem entry THIS listener created; shutdown
					// removes the path only while this identity still matches.
					return resolve(await statSocketIdentity(socketPath));
				}
				resolve(undefined);
			} catch (cause) {
				reject(cause);
			}
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((cause) => (cause ? reject(cause) : resolve()));
	});
}

function hostLog(message: string): void {
	process.stderr.write(`senpi rpc host: ${message}\n`);
}

function isNodeErrorCode(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

function registerShutdownSignals(shutdown: (exitCode?: number) => Promise<never>): void {
	for (const signal of process.platform === "win32" ? (["SIGTERM"] as const) : (["SIGTERM", "SIGHUP"] as const)) {
		process.on(signal, () => {
			killTrackedDetachedChildren();
			void shutdown(signal === "SIGHUP" ? 129 : 143);
		});
	}
}
