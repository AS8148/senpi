import { existsSync, rmSync } from "node:fs";
import { loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { readManifest } from "./bundle.ts";
import type { MoveStatus } from "./move-ledger.ts";
import { type MoveId, SESSION_MOVED, SESSION_RECLAIMED, sessionOwnership } from "./ownership.ts";
import { requeueInput } from "./requeue.ts";

export interface FinishMoveOptions {
	readonly sessionFile: string;
	/** The bundle this device kept while the move was open; it holds the input the release took out. */
	readonly bundleDir: string;
	/** The receiver's signed answer. `receiving` changes nothing: the move is still open. */
	readonly answer: MoveStatus;
}

/**
 * Closes a move on the sending device from the receiver's answer. `accepted` records `session_moved` (read-only for
 * good). `declined`/`failed` takes the session back: `session_reclaimed` makes the file writable, the queued input
 * is re-queued under ids stable per move, then the bundle goes. While the bundle exists the re-queue runs again on
 * the next call, so a crash between any two steps loses nothing and doubles nothing.
 */
export async function finishMove(options: FinishMoveOptions): Promise<void> {
	const { sessionFile, bundleDir, answer } = options;
	const ownership = sessionOwnership(loadEntriesFromFile(sessionFile));
	if (!ownership.writable && ownership.state === "moved") {
		rmSync(bundleDir, { recursive: true, force: true });
		return;
	}
	if (ownership.writable) {
		await requeueDroppedInput(sessionFile, bundleDir);
		rmSync(bundleDir, { recursive: true, force: true });
		return;
	}
	const moveId: MoveId = ownership.moveId;
	switch (answer.state) {
		case "receiving":
			return;
		case "accepted":
			SessionManager.open(sessionFile).appendCustomEntry(SESSION_MOVED, {
				move_id: moveId,
				target: ownership.target,
				moved_at: new Date().toISOString(),
			});
			break;
		case "declined":
		case "failed":
			SessionManager.open(sessionFile).appendCustomEntry(SESSION_RECLAIMED, {
				move_id: moveId,
				reason: answer.state,
				detail: answer.reason,
				reclaimed_at: new Date().toISOString(),
			});
			await requeueDroppedInput(sessionFile, bundleDir);
			break;
		default: {
			const unreachable: never = answer;
			throw new Error(`Unknown move answer ${JSON.stringify(unreachable)}`);
		}
	}
	rmSync(bundleDir, { recursive: true, force: true });
}

export async function requeueDroppedInput(sessionFile: string, bundleDir: string): Promise<void> {
	if (!existsSync(bundleDir)) return;
	const manifest = readManifest(bundleDir);
	await requeueInput(sessionFile, manifest.moveId, manifest.droppedUserMessages);
}
