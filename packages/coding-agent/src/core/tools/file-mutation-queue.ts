import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { realpathWithoutOpenStrict } from "../../utils/paths.ts";
import {
	foldPathForCaseInsensitiveFilesystem,
	isMissingPathError,
	RESOLUTION_TIMED_OUT,
	withResolutionDeadline,
} from "./bounded-realpath.ts";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

/**
 * Every spelling of one file must produce one key, or two mutations of that file run concurrently
 * and the later write silently discards the earlier one. `realpath` supplies that identity,
 * including the on-disk case of an alias such as `Notes.txt` vs `notes.txt`; a path that does not
 * exist yet keys on its resolved form. On a wedged mount `realpath` never returns, so the
 * resolution is bounded and falls back to the open(2)-free walker, and the key is case-folded on
 * filesystems that ignore case so the fallback and the fast path agree on the same file.
 */
async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = resolve(filePath);
	const canonicalPath = await withResolutionDeadline(realpath(resolvedPath)).catch((error: unknown) => {
		if (isMissingPathError(error)) return resolvedPath;
		throw error;
	});
	const identity = canonicalPath === RESOLUTION_TIMED_OUT ? realpathWithoutOpenStrict(resolvedPath) : canonicalPath;
	return foldPathForCaseInsensitiveFilesystem(identity);
}

/**
 * Takes the mutation slot of `filePath` - the same queue and the same file identity as `withFileMutationQueue` - and
 * resolves with its release once every earlier mutation of that file has finished. A waiter whose `signal` aborts
 * rejects without ever holding the slot; the slot it had queued passes on as soon as its predecessor finishes, so later
 * waiters are never stranded. The holder must call the release exactly once (further calls do nothing).
 */
export async function acquireFileMutationLock(filePath: string, signal?: AbortSignal): Promise<() => void> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
	};
	if (signal === undefined) {
		await currentQueue;
		return release;
	}
	const aborted = new Promise<"aborted">((resolveAbort) => {
		if (signal.aborted) resolveAbort("aborted");
		else signal.addEventListener("abort", () => resolveAbort("aborted"), { once: true });
	});
	if ((await Promise.race([currentQueue.then(() => "granted" as const), aborted])) === "granted") return release;
	// Never held: pass the queued slot on once the predecessor finishes, so the next waiter is not stranded.
	void currentQueue.then(release);
	throw signal.reason instanceof Error ? signal.reason : new Error("file mutation lock wait cancelled");
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
