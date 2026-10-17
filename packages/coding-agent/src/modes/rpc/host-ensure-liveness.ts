/**
 * What an ensure may conclude about a registered generation that did not answer: whether anything still
 * accepts at the public path, and whether the generation is alive but stalled (senpi#2566, IS-5). Split
 * out of `host-ensure.ts`; neither check ever signals anything.
 */
import { generationPaths, type HostDaemonPaths } from "./host-daemon-paths.ts";
import { HostEnsureRefusedError, type HostProtocolInfo } from "./host-decision.ts";
import { hostChildAlive, hostLoopStalled, stallRefusalWindowMs } from "./host-stalled-evidence.ts";
import { loopLagErrorMs } from "./loop-lag-threshold.ts";
import { socketEntryListenerState, statSocketIdentity } from "./socket-ownership.ts";

/**
 * IS-5: a generation nothing can reach whose loop is measurably stalled is still serving its sessions, so
 * it is neither stopped nor stranded beside a new generation: no signal, no successor, registration intact.
 */
export async function refuseIfStalled(
	paths: HostDaemonPaths,
	instanceId: string,
	socket: string,
	protocol: HostProtocolInfo | undefined,
): Promise<void> {
	const generation = generationPaths(paths, instanceId);
	const stalled = await hostLoopStalled(generation, {
		now: Date.now(),
		errorMs: loopLagErrorMs(),
		windowMs: stallRefusalWindowMs(),
	});
	if (stalled && (await hostChildAlive(generation)) !== false) {
		throw new HostEnsureRefusedError(socket, "host_stalled", protocol);
	}
}

/**
 * Whether SOMETHING still stands behind the public path - the one fact that says a registered
 * process may still own the endpoint. A missing entry and an entry nobody listens behind both
 * answer no; an accepted connection, however silent, answers yes, and so does any failure that
 * cannot prove absence (`socketEntryListenerState`: EACCES, EAGAIN, a refusal on a platform whose
 * full backlog also refuses while a process still holds the entry). A named pipe has no entry to
 * lose and an abstract socket has no path, so both read as owned; so does an entry this process
 * cannot stat, because an owner that cannot be ruled out is one this ensure must not bind over.
 */
export async function publicEndpointAccepts(socket: string): Promise<boolean> {
	if (process.platform === "win32" || socket.startsWith("\0")) return true;
	const entry = await statSocketIdentity(socket).then(
		(identity) => (identity === undefined ? "absent" : "present"),
		() => "unknown",
	);
	if (entry === "absent") return false;
	if (entry === "unknown") return true;
	return (await socketEntryListenerState(socket)).verdict === "live";
}
