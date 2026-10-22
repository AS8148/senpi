import { type HeldFileLock, lockWithLossHandling } from "../file-lock.ts";
import {
	FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
	FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS,
	isLockError,
} from "../lockfile-policy.ts";

const LOCK_OPTIONS = { realpath: false, stale: 10_000, update: 2_000, retries: 0 } as const;
const LOCK_WAIT_MS = 15_000;

/** Takes a move record's cross-process lock, retrying with backoff for up to `LOCK_WAIT_MS`. */
export async function acquireMoveRecordLock(file: string): Promise<HeldFileLock> {
	const startedAt = Date.now();
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await lockWithLossHandling(file, { ...LOCK_OPTIONS, lockfilePath: `${file}.lock` });
		} catch (error) {
			if (!isLockError(error)) throw error;
			const waited = Date.now() - startedAt;
			if (waited >= LOCK_WAIT_MS)
				throw new Error(`Move record ${file} stayed locked for ${waited}ms`, { cause: error });
			const delay = Math.min(
				FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS * 2 ** attempt,
				FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
			);
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
	}
}
