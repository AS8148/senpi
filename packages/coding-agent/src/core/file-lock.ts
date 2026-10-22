/**
 * The one entry point for async proper-lockfile locks (a source-scan test rejects any other
 * `lockfile.lock(` call under packages/<name>/src).
 *
 * proper-lockfile 4.1.2 refreshes a held lock from a timer: it `stat`s the lock directory, then
 * `utimes` it. Only the `utimes` callback checks `lock.released`. An unlock that lands while the
 * `stat` is in flight therefore gets a late ENOENT for its own, already-removed lock directory,
 * and the dependency reports that as a compromise. The default `onCompromised` throws from a
 * timer callback, which is an uncaught exception that kills the process.
 *
 * `lockWithLossHandling` always passes an `onCompromised` that never throws:
 * - after `release()` it is a no-op (the release race above; nothing is wrong);
 * - while the lock is held it marks the lock lost and logs one structured debug-log entry, so the
 *   critical section can call `assertHeld()` before its commit step and fail only that write
 *   with a typed `FileLockLostError`.
 */
import lockfile from "proper-lockfile";
import { appendDebugLogEntry } from "./hidden-stdout-log.ts";

export type FileLockOptions = Omit<lockfile.LockOptions, "onCompromised"> & {
	/** Called once, while the lock is still held, when the lock is reported compromised. Must not throw. */
	onLost?: (error: Error) => void;
};

export interface HeldFileLock {
	/** Releases the lock. A lost lock is already gone, so releasing it is a no-op. */
	release(): Promise<void>;
	/** True once the lock was reported compromised while held. */
	lost(): boolean;
	/** Throws FileLockLostError when the lock was lost; call right before the commit step. */
	assertHeld(): void;
}

export class FileLockLostError extends Error {
	readonly code = "ELOCKLOST";
	readonly path: string;

	constructor(path: string, cause: Error) {
		super(
			`File lock on ${path} was lost before the write committed: the lock was removed or reclaimed by another process. The write was skipped.`,
			{ cause },
		);
		this.name = "FileLockLostError";
		this.path = path;
	}
}

export async function lockWithLossHandling(path: string, options: FileLockOptions = {}): Promise<HeldFileLock> {
	const { onLost, ...lockOptions } = options;
	let released = false;
	let lostError: Error | undefined;
	const releaseLock = await lockfile.lock(path, {
		...lockOptions,
		onCompromised: (error: Error) => {
			if (released || lostError !== undefined) return;
			lostError = error;
			try {
				appendDebugLogEntry(
					"file lock lost while held",
					JSON.stringify({
						event: "file_lock_lost",
						path,
						lockfilePath: lockOptions.lockfilePath ?? `${path}.lock`,
						code: (error as NodeJS.ErrnoException).code,
						message: error.message,
					}),
				);
			} catch {
				// The debug log is best effort; a failed log write must not turn a lost lock into a crash.
			}
			try {
				onLost?.(error);
			} catch (callbackError) {
				try {
					appendDebugLogEntry("file lock onLost callback threw", String(callbackError));
				} catch {
					// Same as above: this runs on a timer, so nothing here may throw.
				}
			}
		},
	});
	return {
		release: async () => {
			if (released) return;
			released = true;
			if (lostError !== undefined) return;
			await releaseLock();
		},
		lost: () => lostError !== undefined,
		assertHeld: () => {
			if (lostError !== undefined) throw new FileLockLostError(path, lostError);
		},
	};
}
