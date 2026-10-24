/**
 * The engine side of the supervisor's private hop (senpi#3795): the stdin-delivered key and lifetime descriptor
 * from the bootstrap, and how each accepted internal connection is admitted. Split out of multi-session-host.ts.
 */
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { VERSION } from "../../config.ts";
import { HOST_WATCH_LIFETIME_FIFO_ENV } from "./host-lifetime-binding.ts";
import type { HostWatchdogConfig } from "./host-watchdog.ts";
import { getInternalHostBootstrap } from "./internal-bootstrap.ts";
import { acceptInternalConnection } from "./internal-channel.ts";
import { authenticateSocket } from "./socket-transport.ts";

export interface InternalHostTransport {
	/** The supervisor's watchdog binding, plus the reopened stdin lifetime descriptor when the bootstrap has one. */
	readonly watchdogConfig: HostWatchdogConfig | undefined;
	/** Authenticates and seals (POSIX key), authenticates (Windows secret), or accepts as is (no supervisor). */
	admit(socket: Socket, accept: (socket?: Duplex) => void): void;
}

export function internalHostTransport(
	configured: HostWatchdogConfig | undefined,
	secret: Uint8Array | undefined,
): InternalHostTransport {
	const bootstrap = getInternalHostBootstrap();
	// The FIFO path is the host's alone: it is in `configured` now, so no tool or shell the host runs inherits it and
	// could open the FIFO for writing to hold off shutdown (senpi#3816 review).
	delete process.env[HOST_WATCH_LIFETIME_FIFO_ENV];
	return {
		watchdogConfig: configured && {
			...configured,
			...(bootstrap?.lifetimeFd === undefined ? {} : { lifetimeFd: bootstrap.lifetimeFd }),
		},
		admit(socket, accept) {
			if (bootstrap)
				void acceptInternalConnection(socket, bootstrap.key, { protocolVersion: 1, serverVersion: VERSION })
					.then(accept)
					.catch((cause: unknown) => {
						// One line per refused connection: the refusal code only (auth_required, auth_failed, a timeout).
						process.stderr.write(
							`senpi rpc host: internal connection refused: ${cause instanceof Error ? cause.message : "unknown"}\n`,
						);
						socket.destroy();
					});
			else if (secret) authenticateSocket(socket, secret, () => accept());
			else accept();
		},
	};
}
