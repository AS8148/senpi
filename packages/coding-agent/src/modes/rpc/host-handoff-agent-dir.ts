/**
 * Whose host this is: a handoff never crosses agent directories (#3560).
 *
 * A client reads daemon state under ITS OWN agent dir. Pointed at another agent dir's socket - a
 * sandboxed dev server given the user's real `rpc.sock` - it finds no registration there and the
 * unregistered-host path (#2701) would replace the idle host, handing every client of the real agent
 * dir to a host that reads and writes another directory. So the running host's agent dir is settled
 * first, and only a client of that same directory may replace it:
 *
 * - a host that advertises `agentDir` in `get_protocol_info` is taken at its word;
 * - an older host that does not is placed by the layout: when the socket is `<dir>/rpc/rpc.sock`, the
 *   default socket of agent dir `<dir>`, and a layout-2 registration under `<dir>` proves a live owner
 *   of it, the host belongs to `<dir>`;
 * - with neither, nothing is known and the handoff proceeds exactly as before.
 *
 * Both sides are compared canonically (realpath), so a symlinked spelling of the same directory is the
 * same directory. Nothing here signals or touches the running host.
 */
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { provenOwner, readHostRegistration } from "./host-daemon-registration.ts";
import type { HostProtocolInfo } from "./host-protocol-info.ts";

export interface ForeignAgentDirRefusal {
	readonly action: "refuse";
	readonly reason: "foreign_agent_dir";
	readonly upgradeable: false;
	readonly detail: string;
}

/** The refusal for a caller of another agent dir, or `undefined` when the host is the caller's (or unknown). */
export async function foreignAgentDirRefusal(
	socket: string,
	callerAgentDir: string,
	host: HostProtocolInfo,
): Promise<ForeignAgentDirRefusal | undefined> {
	const ours = await canonicalDirectory(callerAgentDir);
	const theirs = host.agentDir !== undefined ? await canonicalDirectory(host.agentDir) : await layoutAgentDir(socket);
	if (theirs === undefined || theirs === ours) return undefined;
	return {
		action: "refuse",
		reason: "foreign_agent_dir",
		upgradeable: false,
		detail: `${socket} is served by the host of agent dir ${theirs}, and this client's agent dir is ${ours}; a host is only replaced by a client of its own agent dir - run with that agent dir to upgrade it, or use a socket of your own`,
	};
}

/** The agent dir an older host belongs to, when its socket is that dir's default and a registration there proves it. */
async function layoutAgentDir(socket: string): Promise<string | undefined> {
	const rpcDirectory = dirname(socket);
	if (basename(socket) !== "rpc.sock" || basename(rpcDirectory) !== "rpc") return undefined;
	const agentDir = dirname(rpcDirectory);
	const paths = createHostDaemonPaths({ socket, agentDir });
	const owner = await provenOwner(await readHostRegistration(paths), socket);
	return owner === undefined ? undefined : canonicalDirectory(agentDir);
}

/** A directory that does not exist (yet) has no realpath; its resolved spelling is the best name for it. */
async function canonicalDirectory(path: string): Promise<string> {
	return realpath(path).catch(() => resolve(path));
}
