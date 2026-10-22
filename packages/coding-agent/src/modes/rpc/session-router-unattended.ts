import type { RouterContext } from "./session-router-context.ts";

function adjust(host: RouterContext, owner: string, sessionId: string, delta: 1 | -1): void {
	const held = host.unattendedByConnection.get(owner) ?? new Map<string, number>();
	const count = (held.get(sessionId) ?? 0) + delta;
	if (count > 0) held.set(sessionId, count);
	else held.delete(sessionId);
	if (held.size > 0) host.unattendedByConnection.set(owner, held);
	else host.unattendedByConnection.delete(owner);
}

/** An `attended: false` open is one of the connection's holds, but never a write attachment. */
export function recordUnattended(host: RouterContext, owner: string, sessionId: string): void {
	adjust(host, owner, sessionId, 1);
}

/** Gives back an unattended hold first, so closing an observation never ends a write attachment. */
export function releaseUnattended(host: RouterContext, owner: string, sessionId: string): void {
	if (host.unattendedByConnection.get(owner)?.has(sessionId)) adjust(host, owner, sessionId, -1);
}

export function holdsWriteAttachment(host: RouterContext, owner: string, sessionId: string): boolean {
	const holds = host.sessionsByConnection.get(owner)?.get(sessionId) ?? 0;
	return holds > (host.unattendedByConnection.get(owner)?.get(sessionId) ?? 0);
}

/** Drops unattended holds with the ownership they belong to: one session, or every session when omitted. */
export function forgetUnattended(host: RouterContext, owner: string | undefined, sessionId?: string): void {
	for (const [connection, held] of host.unattendedByConnection) {
		if (owner !== undefined && connection !== owner) continue;
		if (sessionId === undefined) held.clear();
		else held.delete(sessionId);
		if (held.size === 0) host.unattendedByConnection.delete(connection);
	}
}
