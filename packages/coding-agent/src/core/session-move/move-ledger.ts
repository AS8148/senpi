import { mkdirSync } from "node:fs";
import { readFile, rename as renameFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type HeldFileLock, lockWithLossHandling } from "../file-lock.ts";
import {
	FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
	FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS,
	isLockError,
} from "../lockfile-policy.ts";
import { serializeByKey } from "../session-sidecar-store.ts";
import { parseMoveId } from "./bundle.ts";
import type { MoveId } from "./ownership.ts";

/**
 * The receiving device's record of every move it was offered. Asking about a move is itself a fence: a move this
 * device never heard of is recorded as declined BEFORE the answer leaves, so a later import of it is refused and the
 * sender may safely take its session back. Every writer and the import's final rename share one lock per move.
 */
export type DeclineReason = "no_record" | "expired" | "cancelled" | "chunk_without_ready" | "repository";
export type FailReason = "bundle_invalid" | "import_failed";

/** The answers a sender can hear. */
export type MoveStatus =
	| { readonly state: "receiving" }
	| { readonly state: "accepted" }
	| { readonly state: "declined"; readonly reason: DeclineReason }
	| { readonly state: "failed"; readonly reason: FailReason };

/**
 * A status answer as the sender hears it. `revoked` marks an accepted import the receiver later sealed with `revoke`:
 * the record stays `accepted` (final), but the receiver's copy is read-only, so the sender must take the session back.
 */
export type MoveAnswer = MoveStatus | { readonly state: "accepted"; readonly revoked: true };

/** `ready`: this device told the sender it can take the move; no bundle has been verified yet. */
export type MoveRecord = MoveAnswer | { readonly state: "ready"; readonly expiresAt: string };

/** How long a ready move waits for its bundle before it is declined as expired. */
export const READY_TTL_MS = 10 * 60_000;

const FINAL_STATES: readonly MoveRecord["state"][] = ["accepted", "declined", "failed"];

export interface MoveLedgerOptions {
	readonly now?: () => number;
}

export class MoveFencedError extends Error {
	readonly code = "move_fenced";
	readonly record: MoveRecord;

	constructor(moveId: MoveId, record: MoveRecord) {
		super(`Move ${moveId} can no longer be imported here: it was already answered (${record.state}).`);
		this.name = "MoveFencedError";
		this.record = record;
	}
}

const LOCK_OPTIONS = { realpath: false, stale: 10_000, update: 2_000, retries: 0 } as const;
const LOCK_WAIT_MS = 15_000;

const DECLINE_REASONS: readonly DeclineReason[] = [
	"no_record",
	"expired",
	"cancelled",
	"chunk_without_ready",
	"repository",
];
const FAIL_REASONS: readonly FailReason[] = ["bundle_invalid", "import_failed"];

/** A receiver's answer as it arrives back at the sender; a `ready` record is not an answer. */
export function parseMoveStatus(value: unknown): MoveAnswer | undefined {
	const record = parseRecord(value);
	return record?.state === "ready" ? undefined : record;
}

function parseRecord(value: unknown): MoveRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { state, reason } = value as { readonly state?: unknown; readonly reason?: unknown };
	if (state === "accepted" && (value as { readonly revoked?: unknown }).revoked === true)
		return { state, revoked: true };
	if (state === "receiving") return { state };
	if (state === "accepted") return { state };
	const { expiresAt } = value as { readonly expiresAt?: unknown };
	if (state === "ready" && typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt)))
		return { state, expiresAt };
	const decline = DECLINE_REASONS.find((known) => known === reason);
	if (state === "declined" && decline !== undefined) return { state, reason: decline };
	const fail = FAIL_REASONS.find((known) => known === reason);
	if (state === "failed" && fail !== undefined) return { state, reason: fail };
	return undefined;
}

export class MoveLedger {
	readonly dir: string;
	private readonly now: () => number;
	readonly #held = new Map<string, HeldFileLock>();

	constructor(dir: string, options: MoveLedgerOptions = {}) {
		this.dir = dir;
		this.now = options.now ?? Date.now;
	}

	/**
	 * Says this device can take the move, for `READY_TTL_MS`. Sending ready again keeps the first window; a move already
	 * receiving or accepted stays so, and one already answered otherwise is refused.
	 */
	prepare(moveId: MoveId): Promise<MoveRecord> {
		return this.locked(moveId, async () => {
			const record = await this.current(moveId);
			if (record === undefined) {
				const ready = { state: "ready", expiresAt: new Date(this.now() + READY_TTL_MS).toISOString() } as const;
				await this.write(moveId, ready);
				return ready;
			}
			if (record.state === "ready" || record.state === "receiving" || record.state === "accepted") return record;
			throw new MoveFencedError(moveId, record);
		});
	}

	/**
	 * Starts receiving a verified bundle. Only a move this device readied (and whose window is still open) may start; a
	 * bundle for a move it never readied is declined for good (`chunk_without_ready`). An accepted move, revoked or not,
	 * already landed once and is fenced: re-importing its own file returns before this, and any other target would be a
	 * second writable copy.
	 */
	beginReceive(moveId: MoveId): Promise<void> {
		return this.locked(moveId, async () => {
			const record = await this.current(moveId);
			if (record?.state === "receiving") return;
			if (record?.state === "ready") {
				await this.write(moveId, { state: "receiving" });
				return;
			}
			if (record !== undefined) throw new MoveFencedError(moveId, record);
			const declined = { state: "declined", reason: "chunk_without_ready" } as const;
			await this.write(moveId, declined);
			throw new MoveFencedError(moveId, declined);
		});
	}

	/** Declines a ready move whose window has passed; any other record is returned unchanged. */
	expire(moveId: MoveId): Promise<MoveRecord | undefined> {
		return this.locked(moveId, () => this.current(moveId));
	}

	/**
	 * The signed answer a sender gets. `movedIn` is whether the session file here records the move, `revoked` whether it
	 * records its revoke too (a revoke whose record write was lost still answers revoked).
	 */
	answerStatus(moveId: MoveId, here: { readonly movedIn: boolean; readonly revoked?: boolean }): Promise<MoveAnswer> {
		return this.locked(moveId, async (): Promise<MoveAnswer> => {
			const record = await this.current(moveId);
			if (here.revoked === true) return { state: "accepted", revoked: true } as const;
			if (record?.state === "accepted") return record;
			if (here.movedIn) return { state: "accepted" } as const;
			if (record?.state === "ready") return { state: "receiving" } as const;
			if (record !== undefined) return record;
			const declined = { state: "declined", reason: "no_record" } as const;
			await this.write(moveId, declined);
			return declined;
		});
	}

	/** Cancel, expiry or a refused chunk: only before the bundle was verified and receiving began, never after. */
	decline(moveId: MoveId, reason: DeclineReason): Promise<MoveRecord> {
		return this.settle(moveId, { state: "declined", reason }, ["receiving"]);
	}

	/** A verified import that could not finish; it may end a receiving move but never an accepted one. */
	fail(moveId: MoveId, reason: FailReason): Promise<MoveRecord> {
		return this.settle(moveId, { state: "failed", reason }, []);
	}

	/** Runs the import's commit (the atomic rename) under the move's lock, then records it accepted. */
	commit<T>(moveId: MoveId, rename: () => T | Promise<T>): Promise<T> {
		return this.locked(moveId, async () => {
			const record = await this.read(moveId);
			if (record !== undefined && record.state !== "receiving" && record.state !== "accepted") {
				throw new MoveFencedError(moveId, record);
			}
			const result = await rename();
			// An accepted record is final; a repeated import must not drop a revoke recorded on it.
			if (record?.state !== "accepted") await this.write(moveId, { state: "accepted" });
			return result;
		});
	}

	/**
	 * Records the revoke of this move's import on its accepted record (`revoked: true`; the state stays `accepted`). The
	 * import committed, so a record lost or left `receiving` by a crash becomes accepted and revoked; a repeat changes
	 * nothing, and any other record is left alone.
	 */
	markRevoked(moveId: MoveId): Promise<void> {
		return this.locked(moveId, async () => {
			const record = await this.read(moveId);
			if (record !== undefined && record.state !== "receiving" && record.state !== "accepted") return;
			if (record?.state === "accepted" && "revoked" in record) return;
			await this.write(moveId, { state: "accepted", revoked: true });
		});
	}

	/**
	 * Records a final answer unless one is already there: once a sender may have heard `accepted`, `declined` or
	 * `failed`, it never changes. Reads through `current()`, so a ready move whose window passed answers `expired`.
	 * `keeps` names the open states this transition must also leave alone.
	 */
	private settle(moveId: MoveId, next: MoveRecord, keeps: readonly MoveRecord["state"][]): Promise<MoveRecord> {
		return this.locked(moveId, async () => {
			const record = await this.current(moveId);
			if (record !== undefined && (FINAL_STATES.includes(record.state) || keeps.includes(record.state)))
				return record;
			await this.write(moveId, next);
			return next;
		});
	}

	/** The record, with a ready move whose window has passed declined as expired first (on disk, under the lock). */
	private async current(moveId: MoveId): Promise<MoveRecord | undefined> {
		const record = await this.read(moveId);
		if (record?.state !== "ready" || this.now() < Date.parse(record.expiresAt)) return record;
		const expired = { state: "declined", reason: "expired" } as const;
		await this.write(moveId, expired);
		return expired;
	}

	private path(moveId: MoveId): string {
		return join(this.dir, `${parseMoveId(moveId)}.json`);
	}

	private async read(moveId: MoveId): Promise<MoveRecord | undefined> {
		let raw: string;
		try {
			raw = await readFile(this.path(moveId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const record = parseRecord(JSON.parse(raw));
		if (record === undefined) throw new Error(`Move record ${this.path(moveId)} is not a move record`);
		return record;
	}

	private async write(moveId: MoveId, record: MoveRecord): Promise<void> {
		const file = this.path(moveId);
		const temp = `${file}.${process.pid}.tmp`;
		await writeFile(temp, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
		this.#held.get(file)?.assertHeld();
		await renameFile(temp, file);
	}

	private locked<T>(moveId: MoveId, fn: () => T | Promise<T>): Promise<T> {
		const file = this.path(moveId);
		return serializeByKey(file, async () => {
			mkdirSync(this.dir, { recursive: true });
			const held = await acquire(file);
			this.#held.set(file, held);
			try {
				return await fn();
			} finally {
				this.#held.delete(file);
				await held.release().catch(() => undefined);
			}
		});
	}
}

async function acquire(file: string): Promise<HeldFileLock> {
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
