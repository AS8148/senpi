/**
 * Zero-session trim: when a host that held sessions drops to zero of them, collect once and say what
 * that returned (`host_trimmed`, footprint before and after).
 *
 * Every session's state is per session - its runtime, its extension module graph (#1948) - so once
 * the registry is empty nothing live references it, yet the process keeps the pages until a full
 * collection runs; an idle task shard otherwise sits at its peak footprint for its whole idle window.
 * At most one trim per minute; idle exit is untouched. The single full collection is the accepted
 * exception to the no-sync rule, and the record is what logs it.
 *
 * A busy shard (a parent's task DAG) may never reach zero while it runs: its footprint stayed at
 * 40-60 GB while about 30 children came and went, almost all of it freed heap pages, because a host
 * whose other sessions keep allocating never goes idle long enough to return them (senpi#3218). So a
 * drop in the session count also trims, but only once the footprint is at least
 * {@link DECLINE_TRIM_FLOOR_BYTES}: a small host never pays the collection pause.
 */
import { type ProcessFootprint, readOwnFootprint } from "../../core/process-footprint.ts";
import type { RpcHostTrimmedEvent } from "./rpc-host-lifecycle-types.ts";

export const ZERO_SESSION_TRIM_TICK_MS = 1_000;
export const ZERO_SESSION_TRIM_MIN_INTERVAL_MS = 60_000;
/** Below this footprint a session-count drop with sessions still open does not collect. */
export const DECLINE_TRIM_FLOOR_BYTES = 2 * 1024 * 1024 * 1024;

const BYTES_PER_MEGABYTE = 1024 * 1024;

export interface ZeroSessionTrimmerOptions {
	readonly emit: (record: RpcHostTrimmedEvent) => void;
	/** Live sessions, including ones opening or closing. */
	readonly sessions: () => number;
	readonly now?: () => number;
	readonly readFootprint?: () => ProcessFootprint;
	/** Runs one full collection; `false` when the runtime exposes none. */
	readonly collect?: () => boolean;
}

export class ZeroSessionTrimmer {
	private readonly options: ZeroSessionTrimmerOptions;
	private readonly now: () => number;
	private heldSessions = false;
	private lastSessionCount = 0;
	/** A drop the registry reported between ticks; a backfill in the same second must not hide it. */
	private declined = false;
	private lastTrimAt: number | undefined;
	/** A collection that ran on the previous tick; its record waits for the allocator to return the pages. */
	private pending: { readonly beforeBytes: number; readonly collected: boolean } | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: ZeroSessionTrimmerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	start(): void {
		if (this.timer !== undefined) return;
		// Unref'd: a trim must never be the reason the host stays alive.
		this.timer = setInterval(() => this.check(), ZERO_SESSION_TRIM_TICK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer === undefined) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/** The registry's own signal: any session that existed, however briefly, makes the next zero a transition. */
	observe(size: number): void {
		if (size > 0) this.heldSessions = true;
		if (size < this.lastSessionCount) this.declined = true;
		this.lastSessionCount = size;
	}

	check(): void {
		if (this.pending !== undefined) this.report(this.pending);
		const sessions = this.options.sessions();
		const declined = this.declined || sessions < this.lastSessionCount;
		this.declined = false;
		this.lastSessionCount = sessions;
		if (sessions > 0) {
			this.heldSessions = true;
			if (declined && this.intervalElapsed() && this.readFootprint().bytes >= DECLINE_TRIM_FLOOR_BYTES) {
				this.trim();
			}
			return;
		}
		if (!this.heldSessions) return;
		this.heldSessions = false;
		if (!this.intervalElapsed()) return;
		this.trim();
	}

	private intervalElapsed(): boolean {
		return this.lastTrimAt === undefined || this.now() - this.lastTrimAt >= ZERO_SESSION_TRIM_MIN_INTERVAL_MS;
	}

	private trim(): void {
		const beforeBytes = this.readFootprint().bytes;
		this.pending = { beforeBytes, collected: (this.options.collect ?? collectFully)() };
		this.lastTrimAt = this.now();
	}

	/** One tick after the collection: freed pages are decommitted lazily, so an immediate read shows none of it. */
	private report(pending: { readonly beforeBytes: number; readonly collected: boolean }): void {
		this.pending = undefined;
		const after = this.readFootprint();
		this.options.emit({
			type: "host_trimmed",
			footprintBeforeMb: Math.round(pending.beforeBytes / BYTES_PER_MEGABYTE),
			footprintAfterMb: Math.round(after.bytes / BYTES_PER_MEGABYTE),
			measure: after.measure,
			collected: pending.collected,
		});
	}

	private readFootprint(): ProcessFootprint {
		return (this.options.readFootprint ?? readOwnFootprint)();
	}
}

/** `Bun.gc(true)` on Bun, `gc()` on Node started with `--expose-gc`, otherwise nothing. */
export function collectFully(): boolean {
	const bun: unknown = Reflect.get(globalThis, "Bun");
	const bunGc: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
	if (typeof bunGc === "function") {
		Reflect.apply(bunGc, bun, [true]);
		return true;
	}
	const nodeGc: unknown = Reflect.get(globalThis, "gc");
	if (typeof nodeGc !== "function") return false;
	Reflect.apply(nodeGc, globalThis, []);
	return true;
}
