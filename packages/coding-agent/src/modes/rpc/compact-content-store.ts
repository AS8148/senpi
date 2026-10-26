import { join } from "node:path";
import { createSpoolDir, removeSpoolDir } from "./compact-spool-dir.ts";
import {
	type CompactStorageFailure,
	type CompactStorageIo,
	type CompactStorageOperation,
	CompactStorageReadError,
	describeCause,
	nodeCompactStorageIo,
} from "./compact-storage-io.ts";

/**
 * Owned bounded leaves for compact current state (senpi#4272, R3.C6.4 / R3.C2.4).
 *
 * Acceptance never waits here: a leaf is created synchronously in RAM, and a spill only relocates
 * that immutable value. Its RAM copy is released only after the whole file was written and closed;
 * a failed write keeps the bytes resident, halts further spilling and is reported through
 * `status()`, never dropped. All storage work runs as one serial asynchronous job chain.
 */

/** 32,768 UTF-16 code units (64 KiB as UTF-16LE), so a split surrogate survives a leaf boundary exactly. */
export const COMPACT_LEAF_CODE_UNITS = 32_768;
const RECLAIM_WORK_ALLOWANCE_BYTES = 1024 * 1024;
const RECLAIM_RETRY_DELAYS_MS = [100, 400, 1_600, 6_400, 25_600];
const FAILURE_HISTORY = 32;

export type LeafId = number;

export interface CompactStorageStatus {
	readonly residentPayloadBytes: number;
	readonly pendingIoCopyBytes: number;
	readonly pinnedOnlyBytes: number;
	readonly spilledLiveBytes: number;
	readonly spillBytesWritten: number;
	readonly reclaimDebtBytes: number;
	/** Resident bytes above the spill target that a halted spool keeps in RAM (ruling 08 condition 1). */
	readonly spillFailureRetainedBytes: number;
	readonly spillHalted: boolean;
	readonly failures: readonly CompactStorageFailure[];
}

export interface CompactContentStoreOptions {
	/** Private epoch spool directory the store creates itself (0700, never an existing one; files 0600). Not a transcript. */
	readonly dir: string;
	readonly io?: CompactStorageIo;
	/** Spilling starts above this many resident leaf bytes and stops at the target. */
	readonly spillAboveBytes?: number;
	readonly spillTargetBytes?: number;
}

interface Leaf {
	text: string | undefined;
	readonly units: number;
	live: number;
	pins: number;
	state: "ram" | "pending" | "committed";
	path?: string;
}

export class CompactContentStore {
	readonly dir: string;
	private readonly io: CompactStorageIo;
	private readonly spillAboveBytes: number;
	private readonly spillTargetBytes: number;
	private readonly leaves = new Map<LeafId, Leaf>();
	/** Resident leaves in creation order, so each spill takes the oldest without rescanning committed ones. */
	private readonly ramLeaves = new Set<LeafId>();
	private readonly failures: CompactStorageFailure[] = [];
	private nextLeafId = 1;
	private nextFile = 1;
	private dirReady: Promise<string | undefined> | undefined;
	private spoolToken: string | undefined;
	private chain: Promise<void> = Promise.resolve();
	private queued = 0;
	private spillQueued = false;
	private halted = false;
	private retired = false;
	private residentPayloadBytes = 0;
	private pendingIoCopyBytes = 0;
	private pinnedOnlyBytes = 0;
	private spilledLiveBytes = 0;
	private spillBytesWritten = 0;
	private reclaimDebtBytes = 0;

	constructor(options: CompactContentStoreOptions) {
		this.dir = options.dir;
		this.io = options.io ?? nodeCompactStorageIo;
		this.spillAboveBytes = options.spillAboveBytes ?? 4 * 1024 * 1024;
		this.spillTargetBytes = options.spillTargetBytes ?? 2 * 1024 * 1024;
	}

	/** Takes ownership of an immutable value with one live reference. */
	createLeaf(text: string): LeafId {
		const id = this.nextLeafId++;
		this.leaves.set(id, { text, units: text.length, live: 1, pins: 0, state: "ram" });
		this.ramLeaves.add(id);
		this.residentPayloadBytes += text.length * 2;
		this.scheduleSpill();
		return id;
	}

	/** Moves live and cut-pin references; the last reference drops RAM or reclaims the file. */
	adjust(id: LeafId, live: number, pins: number): void {
		const leaf = this.leaves.get(id);
		if (!leaf) throw new Error(`compact leaf ${id} is not owned`);
		const pinnedOnly = leaf.live === 0 && leaf.pins > 0;
		leaf.live += live;
		leaf.pins += pins;
		if (pinnedOnly !== (leaf.live === 0 && leaf.pins > 0)) this.pinnedOnlyBytes += (pinnedOnly ? -2 : 2) * leaf.units;
		if (leaf.live > 0 || leaf.pins > 0) return;
		this.leaves.delete(id);
		this.ramLeaves.delete(id);
		if (leaf.state === "committed" && leaf.path) {
			this.spilledLiveBytes -= leaf.units * 2;
			this.discard(leaf.path, leaf.units * 2);
			return;
		}
		this.residentPayloadBytes -= leaf.units * 2;
	}

	/** Reads a leaf the caller still references, from RAM or its committed file. */
	async readLeaf(id: LeafId): Promise<string> {
		const leaf = this.leaves.get(id);
		if (!leaf) throw new Error(`compact leaf ${id} is not owned`);
		if (leaf.text !== undefined) return leaf.text;
		return (await this.readFile(leaf.path ?? "", leaf.units * 2, "leaf_read")).toString("utf16le");
	}

	/** Resolves once every queued storage job, including the ones they queued, has completed. */
	async idle(): Promise<void> {
		while (this.queued > 0) await this.chain;
	}

	/**
	 * Invalidates spilling, joins owned I/O, then removes the epoch directory only when this store
	 * created it and it still passes the ownership checks; otherwise rejects with `CompactSpoolRefusedError`.
	 */
	async retire(): Promise<void> {
		this.retired = true;
		await this.idle();
		const token = this.spoolToken;
		this.spoolToken = undefined;
		if (token !== undefined) await removeSpoolDir(this.dir, token);
	}

	status(): CompactStorageStatus {
		return {
			residentPayloadBytes: this.residentPayloadBytes,
			pendingIoCopyBytes: this.pendingIoCopyBytes,
			pinnedOnlyBytes: this.pinnedOnlyBytes,
			spilledLiveBytes: this.spilledLiveBytes,
			spillBytesWritten: this.spillBytesWritten,
			reclaimDebtBytes: this.reclaimDebtBytes,
			spillFailureRetainedBytes: this.spillStopped
				? Math.max(0, this.residentPayloadBytes - this.spillTargetBytes)
				: 0,
			spillHalted: this.spillStopped,
			failures: [...this.failures],
		};
	}

	/** Reads a committed file and rejects a missing, unreadable or short one. */
	private async readFile(path: string, bytes: number, operation: CompactStorageOperation): Promise<Buffer> {
		let data: Buffer;
		try {
			data = await this.io.readFile(path);
		} catch (cause) {
			throw this.readFailure(operation, path, cause);
		}
		if (data.byteLength !== bytes) {
			throw this.readFailure(operation, path, new Error(`expected ${bytes} bytes, found ${data.byteLength}`));
		}
		return data;
	}

	/** Writes one new spool file; undefined means the write failed, was reported, and spilling halted. */
	private async writeFile(
		data: Buffer,
		operation: CompactStorageOperation,
		retainedInMemoryBytes: number,
	): Promise<string | undefined> {
		const path = await this.ensureDir(retainedInMemoryBytes);
		if (path === undefined) return undefined;
		const file = join(path, `leaf-${this.nextFile++}.bin`);
		this.pendingIoCopyBytes += data.byteLength;
		try {
			await this.io.writeFile(file, data);
			this.spillBytesWritten += data.byteLength;
			return file;
		} catch (cause) {
			this.fail(operation, file, cause, retainedInMemoryBytes);
			this.discard(file, data.byteLength);
			return undefined;
		} finally {
			this.pendingIoCopyBytes -= data.byteLength;
		}
	}

	/**
	 * An unreferenced (or partially written) spool file: reclamation debt until its unlink completes or
	 * finds it gone. Files dropped after retirement started belong to the directory retirement removes.
	 */
	private discard(path: string, bytes: number): void {
		if (this.retired) return;
		this.reclaimDebtBytes += bytes;
		this.enqueue("reclaim", () => this.reclaim(path, bytes, 0));
	}

	/** A failed unlink keeps its debt and is retried with bounded backoff outside the job chain. */
	private async reclaim(path: string, bytes: number, attempt: number): Promise<void> {
		try {
			await this.io.unlink(path);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
				this.fail("reclaim", path, cause, 0);
				const delay = RECLAIM_RETRY_DELAYS_MS[attempt];
				if (delay !== undefined) {
					setTimeout(() => {
						if (this.retired) this.reclaimDebtBytes -= bytes;
						else this.enqueue("reclaim", () => this.reclaim(path, bytes, attempt + 1));
					}, delay).unref?.();
				}
				return;
			}
		}
		this.reclaimDebtBytes -= bytes;
		this.scheduleSpill();
	}

	private get spillAllowed(): boolean {
		return !this.halted && !this.retired;
	}

	/** True while a storage failure or unreclaimed debt above the work allowance holds spilling back. */
	private get spillStopped(): boolean {
		return this.halted || this.reclaimDebtBytes > RECLAIM_WORK_ALLOWANCE_BYTES;
	}

	private enqueue(operation: CompactStorageOperation, job: () => Promise<void>): void {
		this.queued++;
		this.chain = this.chain
			.then(job)
			.catch((cause: unknown) => {
				if (operation === "spill_write") this.spillQueued = false;
				this.fail(operation, this.dir, cause, 0);
			})
			.finally(() => {
				this.queued--;
			});
	}

	private scheduleSpill(): void {
		if (this.spillQueued || !this.spillAllowed || this.residentPayloadBytes <= this.spillAboveBytes) return;
		if (this.reclaimDebtBytes > RECLAIM_WORK_ALLOWANCE_BYTES) return;
		this.spillQueued = true;
		this.enqueue("spill_write", () => this.spillNext());
	}

	/** Spills one oldest resident leaf per job, so other storage work interleaves fairly. */
	private async spillNext(): Promise<void> {
		const [id] = this.ramLeaves;
		const leaf = id === undefined ? undefined : this.leaves.get(id);
		if (id === undefined || !leaf || leaf.text === undefined || !this.spillAllowed) {
			this.spillQueued = false;
			return;
		}
		const bytes = leaf.units * 2;
		leaf.state = "pending";
		this.ramLeaves.delete(id);
		const path = await this.writeFile(Buffer.from(leaf.text, "utf16le"), "spill_write", bytes);
		const owned = this.leaves.get(id) === leaf;
		if (path === undefined) {
			leaf.state = "ram";
			if (owned) this.ramLeaves.add(id);
		} else if (!owned || this.retired) {
			this.discard(path, bytes);
		} else {
			leaf.state = "committed";
			leaf.path = path;
			leaf.text = undefined;
			this.residentPayloadBytes -= bytes;
			this.spilledLiveBytes += bytes;
		}
		this.spillQueued = false;
		if (this.residentPayloadBytes > this.spillTargetBytes) {
			this.spillQueued = this.spillAllowed;
			if (this.spillQueued) this.enqueue("spill_write", () => this.spillNext());
		}
	}

	/** Creates the private epoch directory once; a refusal or failure halts spilling and is reported. */
	private ensureDir(retained: number): Promise<string | undefined> {
		this.dirReady ??= createSpoolDir(this.dir).then(
			(token) => {
				this.spoolToken = token;
				return this.dir;
			},
			(cause: unknown) => {
				this.fail("spool_create", this.dir, cause, retained);
				return undefined;
			},
		);
		return this.dirReady;
	}

	private readFailure(operation: CompactStorageOperation, path: string, cause: unknown): CompactStorageReadError {
		this.fail(operation, path, cause, 0);
		return new CompactStorageReadError(operation, path, cause);
	}

	private fail(operation: CompactStorageOperation, path: string, cause: unknown, retained: number): void {
		if (operation === "spill_write" || operation === "spool_create") this.halted = true;
		this.record({ operation, path, cause: describeCause(cause), retainedInMemoryBytes: retained });
	}

	private record(failure: CompactStorageFailure): void {
		this.failures.push(failure);
		if (this.failures.length > FAILURE_HISTORY) this.failures.shift();
	}
}
