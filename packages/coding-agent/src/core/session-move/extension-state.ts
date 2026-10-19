import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { parseMoveId } from "./bundle.ts";
import { type MoveId, SESSION_MOVED_IN } from "./ownership.ts";

/**
 * State an extension keeps outside the session folder (task records, logs, finished child sessions) and wants to
 * follow a moved session (senpi#3676, design v7 section 4). The sender's extensions write it into a staging folder at
 * the `move` release, while their runtime is still live (`session_move_export`); export bundles that folder as the
 * `extension-state` payload; import unpacks it next to the session (`movedStateDir`); and the next open hands it to the
 * receiver's extensions once (`session_move_import`), then records `session_move_state_restored` and removes it.
 */
export const EXTENSION_STATE_PAYLOAD = "extension-state";
export const MOVED_STATE_RESTORED = "session_move_state_restored";

const MOVE_STATE = ".move-state";

export function outgoingStateDir(sessionFile: string, moveId: MoveId): string {
	return join(dirname(sessionFile), MOVE_STATE, "out", parseMoveId(moveId));
}

export function movedStateDir(sessionFile: string, moveId: MoveId): string {
	return join(dirname(sessionFile), MOVE_STATE, "in", `${basename(sessionFile, ".jsonl")}.${parseMoveId(moveId)}`);
}

/** Creates the empty staging folder an export event writes into (an earlier attempt's leftovers are discarded). */
export function prepareOutgoingState(sessionFile: string, moveId: MoveId): string {
	const dir = outgoingStateDir(sessionFile, moveId);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	return dir;
}

interface EntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

const moveIdOf = (entry: EntryLike): string | undefined => {
	const value = (entry.data as { readonly move_id?: unknown } | undefined)?.move_id;
	return typeof value === "string" ? value : undefined;
};

/**
 * The state the last move into this session left for its extensions, if it has not been handed over yet. Only the
 * newest `session_moved_in` counts, and only until a `session_move_state_restored` for that move is written.
 */
export function pendingMovedState(sessionFile: string): { readonly moveId: MoveId; readonly dir: string } | undefined {
	if (!existsSync(sessionFile)) return undefined;
	const entries: readonly EntryLike[] = loadEntriesFromFile(sessionFile);
	const movedIn = entries.findLast((entry) => entry.type === "custom" && entry.customType === SESSION_MOVED_IN);
	const moveId = movedIn === undefined ? undefined : moveIdOf(movedIn);
	if (moveId === undefined) return undefined;
	const restored = entries.some(
		(entry) => entry.type === "custom" && entry.customType === MOVED_STATE_RESTORED && moveIdOf(entry) === moveId,
	);
	if (restored) return undefined;
	const id = parseMoveId(moveId);
	const dir = movedStateDir(sessionFile, id);
	return existsSync(dir) ? { moveId: id, dir } : undefined;
}

/**
 * Hands pending moved state to the session's extensions once: `deliver` runs the import handlers, then the restored
 * marker is written and the folder removed. A crash before the marker re-delivers on the next open (handlers must be
 * idempotent); a crash after it only leaves a folder that is never read again and is removed here next time.
 */
export async function restoreMovedState(
	sessionManager: SessionManager,
	deliver: (event: { readonly moveId: MoveId; readonly dir: string }) => Promise<void>,
): Promise<void> {
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined) return;
	const pending = pendingMovedState(sessionFile);
	if (pending === undefined) return;
	await deliver(pending);
	sessionManager.appendCustomEntry(MOVED_STATE_RESTORED, {
		move_id: pending.moveId,
		restored_at: new Date().toISOString(),
	});
	rmSync(pending.dir, { recursive: true, force: true });
}
