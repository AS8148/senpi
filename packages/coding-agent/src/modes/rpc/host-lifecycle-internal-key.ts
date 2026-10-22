/**
 * The supervisor's private hop (senpi#3795): its path, the transport credentials the child, the activity observer and
 * the public proxy share (a Windows pipe secret, or a fresh memory-only POSIX key the child gets on stdin), and the
 * supervisor's own start time for the child's lifetime poll. Split out of host-lifecycle.ts.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, openSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readProcessStartTicks } from "../../utils/process-start-identity.ts";
import { createInternalSocketPath } from "./host-lifecycle-scratch.ts";
import { createSocketSecret, socketSecretPath } from "./socket-transport.ts";

/**
 * The supervisor's lifetime FIFO (senpi#3816 round 7): mode 0600 inside its private 0700 hop directory. The writer is
 * opened O_RDWR, which never blocks, before the host is spawned, and held for the supervisor's whole life; Node opens
 * every file close-on-exec, so neither the host nor any grandchild inherits a writer and the supervisor's death (any
 * cause) closes the last one. A fresh hop directory per start means a stale FIFO only lives in a crashed start's
 * directory, which the internal-directory reaper removes; clean shutdown removes the hop directory with it.
 * Node and Bun have no mkfifo call, so this is the one spawn at supervisor start.
 */
function createLifetimeFifo(dir: string): string | undefined {
	const path = join(dir, "lifetime.fifo");
	try {
		rmSync(path, { force: true });
		execFileSync("mkfifo", ["-m", "600", path], { stdio: "ignore" });
		openSync(path, constants.O_RDWR);
		return path;
	} catch {
		// Without the FIFO the host keeps its other bindings (reopened stdin, the recorded-identity poll).
		return undefined;
	}
}

/** The start time the hop directory's owner record already holds, so it is read (spawned) once, not twice. */
async function recordedOwnerStartTime(dir: string | undefined): Promise<string | undefined> {
	if (dir === undefined) return undefined;
	try {
		const owner: unknown = JSON.parse(await readFile(join(dir, ".owner"), "utf8"));
		const start = owner !== null && typeof owner === "object" ? Reflect.get(owner, "processStartTime") : undefined;
		return typeof start === "string" ? start : undefined;
	} catch {
		// An unreadable record leaves the child's identity poll without a start time: unknown, never death.
		return undefined;
	}
}

export async function prepareInternalHop(daemonDir: string) {
	const created = await createInternalSocketPath(daemonDir);
	const internal = { ...created, secretPath: created.secretPath ?? socketSecretPath(created.socket) };
	const internalSecret = process.platform === "win32" ? await createSocketSecret(internal.secretPath) : undefined;
	const internalKey = process.platform === "win32" ? undefined : randomBytes(32);
	return {
		internal,
		internalSocket: internal.socket,
		internalSecret,
		internalKey,
		// The child compares these on one clock per platform: ps lstart off Linux, /proc start ticks on Linux.
		// Linux only: there libuv reports a FIFO's EOF (Node net.Socket, Bun file stream); on macOS it does not, and the
		// reopened stdin is the event binding instead (measured, senpi#3816 round 7).
		lifetimeFifo:
			internalKey && internal.dir !== undefined && process.platform === "linux"
				? createLifetimeFifo(internal.dir)
				: undefined,
		supervisorStart: internalKey
			? { time: await recordedOwnerStartTime(internal.dir), ticks: readProcessStartTicks(process.pid) }
			: undefined,
		transport: { ...(internalSecret ? { internalSecret } : {}), ...(internalKey ? { internalKey } : {}) },
	};
}
