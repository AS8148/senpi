import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
	FILE_STORAGE_LOCK_RETRY_MAX_DELAY_MS,
	FILE_STORAGE_LOCK_RETRY_MIN_DELAY_MS,
	isLockError,
} from "../lockfile-policy.ts";
import { serializeByKey } from "../session-sidecar-store.ts";
import type { MoveId } from "./ownership.ts";

/**
 * The receiving device's record of every move it was offered. Asking about a move is itself a fence: a move this
 * device never heard of is recorded as declined BEFORE the answer leaves, so a later import of it is refused and the
 * sender may safely take its session back. Every writer and the import's final rename share one lock per move.
 */
export type DeclineReason = "no_record" | "expired" | "cancelled" | "chunk_without_ready" | "repository";
export type FailReason = "bundle_invalid" | "import_failed";

export type MoveRecord =
	| { readonly state: "receiving" }
	| { readonly state: "accepted" }
	| { readonly state: "declined"; readonly reason: DeclineReason }
	| { readonly state: "failed"; readonly reason: FailReason };

export type MoveStatus = MoveRecord;

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

function parseRecord(value: unknown): MoveRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { state, reason } = value as { readonly state?: unknown; readonly reason?: unknown };
	if (state === "receiving" || state === "accepted") return { state };
	const decline = DECLINE_REASONS.find((known) => known === reason);
	if (state === "declined" && decline !== undefined) return { state, reason: decline };
	const fail = FAIL_REASONS.find((known) => known === reason);
	if (state === "failed" && fail !== undefined) return { state, reason: fail };
	return undefined;
}

export class MoveLedger {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	/** Starts receiving a move; refused once the move was answered with anything but `receiving`. */
	beginReceive(moveId: MoveId): Promise<void> {
		return this.locked(moveId, () => {
			const record = this.read(moveId);
			if (record?.state === "accepted" || record?.state === "receiving") return;
			if (record !== undefined) throw new MoveFencedError(moveId, record);
			this.write(moveId, { state: "receiving" });
		});
	}

	/** The signed answer a sender gets; `movedIn` is whether the session file here already records the move. */
	answerStatus(moveId: MoveId, here: { readonly movedIn: boolean }): Promise<MoveStatus> {
		return this.locked(moveId, () => {
			const record = this.read(moveId);
			if (here.movedIn || record?.state === "accepted") return { state: "accepted" } as const;
			if (record !== undefined) return record;
			const declined = { state: "declined", reason: "no_record" } as const;
			this.write(moveId, declined);
			return declined;
		});
	}

	/** Cancel, expiry or a refused chunk: only before the bundle was verified and receiving began, never after. */
	decline(moveId: MoveId, reason: DeclineReason): Promise<MoveRecord> {
		return this.settle(moveId, { state: "declined", reason }, ["accepted", "receiving"]);
	}

	/** A verified import that could not finish; it may end a receiving move but never an accepted one. */
	fail(moveId: MoveId, reason: FailReason): Promise<MoveRecord> {
		return this.settle(moveId, { state: "failed", reason }, ["accepted"]);
	}

	/** Runs the import's commit (the atomic rename) under the move's lock, then records it accepted. */
	commit<T>(moveId: MoveId, rename: () => T | Promise<T>): Promise<T> {
		return this.locked(moveId, async () => {
			const record = this.read(moveId);
			if (record !== undefined && record.state !== "receiving" && record.state !== "accepted") {
				throw new MoveFencedError(moveId, record);
			}
			const result = await rename();
			this.write(moveId, { state: "accepted" });
			return result;
		});
	}

	private settle(moveId: MoveId, next: MoveRecord, keeps: readonly MoveRecord["state"][]): Promise<MoveRecord> {
		return this.locked(moveId, () => {
			const record = this.read(moveId);
			if (record !== undefined && keeps.includes(record.state)) return record;
			this.write(moveId, next);
			return next;
		});
	}

	private path(moveId: MoveId): string {
		return join(this.dir, `${encodeURIComponent(moveId)}.json`);
	}

	private read(moveId: MoveId): MoveRecord | undefined {
		let raw: string;
		try {
			raw = readFileSync(this.path(moveId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const record = parseRecord(JSON.parse(raw));
		if (record === undefined) throw new Error(`Move record ${this.path(moveId)} is not a move record`);
		return record;
	}

	private write(moveId: MoveId, record: MoveRecord): void {
		const file = this.path(moveId);
		const temp = `${file}.${process.pid}.tmp`;
		writeFileSync(temp, `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
		renameSync(temp, file);
	}

	private locked<T>(moveId: MoveId, fn: () => T | Promise<T>): Promise<T> {
		const file = this.path(moveId);
		return serializeByKey(file, async () => {
			mkdirSync(this.dir, { recursive: true });
			const release = await acquire(file);
			try {
				return await fn();
			} finally {
				await release().catch(() => undefined);
			}
		});
	}
}

async function acquire(file: string): Promise<() => Promise<void>> {
	const startedAt = Date.now();
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await lockfile.lock(file, { ...LOCK_OPTIONS, lockfilePath: `${file}.lock` });
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
