/**
 * F13: one `loaded_surfaces_changed` per connection per inventory change, never one per session.
 *
 * The dedupe is transition-aware. Per connection it remembers, for every session, the digest that
 * session was last announced at and the digest it arrived from. A session's change is told only when
 * no OTHER session already announced the same transition (the same previous digest to the same new
 * one): sessions moving together share one event, but a session that converges onto a digest the
 * connection heard from a different starting point still announces its own change, because surface
 * reads (`get_commands`, `get_loaded_surfaces`) are per session and one event names one session.
 */
export class SurfaceDigestDedupe {
	/** Per connection, per session: the digest last announced and the one it arrived from. */
	private readonly connections = new Map<string, Map<string, { last: string; previous: string | undefined }>>();

	/**
	 * Record one session's move to `digest` for a connection. Returns true when the connection must
	 * hear about it; the move is recorded either way, so the session's next transition is judged
	 * against where it actually arrived.
	 */
	announce(connectionId: string, sessionId: string, digest: string): boolean {
		let sessions = this.connections.get(connectionId);
		if (sessions === undefined) {
			sessions = new Map();
			this.connections.set(connectionId, sessions);
		}
		const previous = sessions.get(sessionId)?.last;
		if (previous === digest) return false;
		let tell = true;
		for (const [other, announced] of sessions) {
			if (other === sessionId || announced.last !== digest) continue;
			if (announced.previous === previous) {
				tell = false;
				break;
			}
		}
		sessions.set(sessionId, { last: digest, previous });
		return tell;
	}

	dropConnection(connectionId: string): void {
		this.connections.delete(connectionId);
	}

	forgetSession(sessionId: string): void {
		for (const sessions of this.connections.values()) sessions.delete(sessionId);
	}
}
