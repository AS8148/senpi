import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { serializeByKey } from "../session-sidecar-store.ts";

export function realSessionPath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

/**
 * Runs the sender's steps of a move (export, finish) one at a time per session file. A second `finish` for the same
 * move then starts after the first has settled and finds the move already closed, so the queued input it hands back
 * is re-queued once, never twice.
 */
export function withSessionMoveLock<T>(sessionFile: string, step: () => Promise<T>): Promise<T> {
	return serializeByKey(`session-move:${realSessionPath(sessionFile)}`, step);
}
