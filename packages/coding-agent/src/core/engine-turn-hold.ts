import { EngineTurnHoldNotices } from "./engine-turn-hold-notices.ts";
import type { CustomMessage } from "./messages.ts";
import type { SessionEntry } from "./session-manager.ts";

export type HoldKind = "unattended";
export type HoldReleaseCause = "input" | "resume_session";
export interface SessionHold {
	kind: HoldKind;
	key: string;
	since: string;
	data?: unknown;
	sourceCounts: Record<string, number>;
}
export type SessionHoldEvent =
	| { type: "session_paused"; pauseSeq: number; kind: HoldKind; at: string; noticeCount: number; persisted: boolean }
	| { type: "session_resumed"; pauseSeq: number; cause: HoldReleaseCause; at: string };
type HoldEntry =
	| { op: "add"; kind: HoldKind; key: string; data?: unknown; pauseSeq: number; at: string }
	| { op: "release"; keys: string[]; observedSeq: number; cause: HoldReleaseCause; at: string }
	| {
			op: "resume";
			resumeId: string;
			pauseSeq: number;
			phase: "requested" | "delivery_pending" | "settled";
			at: string;
	  };

export function engineWakeSource(customType: string): string {
	if (customType === "goal-continuation") return "goal";
	if (customType.startsWith("senpi-monitor:")) return "monitor";
	if (customType.startsWith("senpi-codemode:")) return "codemode";
	return customType;
}

/** One session-scoped hold ledger, independent of the transcript leaf. */
export class EngineTurnHold {
	private records = new Map<string, SessionHold>();
	private readonly notices: EngineTurnHoldNotices;
	private pauseSeq = 0;
	private resumeId: string | undefined;
	private released: SessionHold[] = [];
	private releaseBarrier = false;
	goalDeferred = false;
	generation = 0;
	private readonly unattended: boolean;
	private readonly append: (type: string, data: unknown) => void;
	private readonly notify: (message: string) => void;
	private readonly emit: (event: SessionHoldEvent) => void;

	constructor(
		entries: readonly SessionEntry[],
		unattended: boolean,
		append: (type: string, data: unknown) => void,
		notify: (message: string) => void,
		emit: (event: SessionHoldEvent) => void,
	) {
		this.unattended = unattended;
		this.append = append;
		this.notify = notify;
		this.emit = emit;
		this.notices = new EngineTurnHoldNotices(entries, append);
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== "session-hold") continue;
			const data = entry.data as HoldEntry;
			if (data.op === "add") {
				this.pauseSeq = Math.max(this.pauseSeq, data.pauseSeq);
				this.records.set(data.key, {
					kind: data.kind,
					key: data.key,
					since: data.at,
					data: data.data,
					sourceCounts: {},
				});
			} else if (data.op === "release") {
				for (const key of data.keys) this.records.delete(key);
			}
		}
	}

	isHeld(): boolean {
		return this.records.size > 0;
	}

	get held(): boolean {
		return this.isHeld();
	}

	get awaitingInput(): boolean {
		return this.isHeld() || this.releaseBarrier;
	}

	get holds(): SessionHold[] {
		return [...this.records.values()].map((hold) => ({ ...hold, sourceCounts: this.sources }));
	}

	getHold(key: string): SessionHold | undefined {
		const hold = this.records.get(key);
		return hold ? { ...hold, sourceCounts: this.sources } : undefined;
	}

	get sources(): Record<string, number> {
		return this.notices.sources;
	}

	get noticeCount(): number {
		return this.notices.noticeCount;
	}

	start(): void {
		if (this.unattended) this.addHold("unattended");
		if (this.isHeld() && this.noticeCount > 0) this.showNotice();
	}

	addHold(kind: HoldKind, opts?: { key?: string; data?: unknown }): void {
		const key = opts?.key ?? kind;
		if (this.records.has(key)) return;
		const wasHeld = this.isHeld();
		const at = new Date().toISOString();
		this.pauseSeq++;
		this.records.set(key, { kind, key, since: at, data: opts?.data, sourceCounts: {} });
		let persisted = false;
		try {
			this.append("session-hold", {
				op: "add",
				kind,
				key,
				data: opts?.data,
				pauseSeq: this.pauseSeq,
				at,
			} satisfies HoldEntry);
			persisted = true;
		} finally {
			if (!wasHeld)
				this.emit({
					type: "session_paused",
					pauseSeq: this.pauseSeq,
					kind,
					at,
					noticeCount: this.noticeCount,
					persisted,
				});
			if (!persisted) this.notify("Pause could not be saved; it will not survive a restart.");
		}
	}

	release(keys: string[], cause: HoldReleaseCause): void {
		const present = [...new Set(keys)].filter((key) => this.records.has(key));
		if (present.length === 0) return;
		const at = new Date().toISOString();
		this.append("session-hold", {
			op: "release",
			keys: present,
			observedSeq: this.pauseSeq,
			cause,
			at,
		} satisfies HoldEntry);
		for (const key of present) this.records.delete(key);
		if (!this.isHeld()) this.emit({ type: "session_resumed", pauseSeq: this.pauseSeq, cause, at });
	}

	holdsSource(source: string): boolean {
		return this.awaitingInput || (source === "goal" && this.goalDeferred);
	}

	note(source: string, message?: CustomMessage): void {
		this.notices.note(source, this.pauseSeq, message);
		this.showNotice();
	}

	messages(): ReturnType<EngineTurnHoldNotices["messages"]> {
		return this.notices.messages();
	}

	releaseAll(cause: HoldReleaseCause): Record<string, number> {
		const sources = this.sources;
		if (!this.awaitingInput) return sources;
		this.generation++;
		if (this.isHeld()) this.released = this.holds;
		this.resumeId = crypto.randomUUID();
		this.recordResume("requested");
		this.releaseBarrier = true;
		this.goalDeferred = (sources.goal ?? 0) > 0;
		this.release([...this.records.keys()], cause);
		this.recordResume("delivery_pending");
		return sources;
	}

	rejectInput(): void {
		this.releaseBarrier = false;
		this.goalDeferred = false;
		for (const { kind, key, data } of this.released) this.addHold(kind, { key, data });
	}

	consume(source: string, deliveredIds?: readonly string[]): void {
		this.notices.consume(source, this.pauseSeq, deliveredIds);
	}

	finish(): Record<string, number> {
		const sources = this.sources;
		// Wakes arriving after the delivery snapshot still belong to the ledger.
		// Re-arm the hold rather than draining an unbounded stream in this release.
		if (Object.keys(sources).some((source) => source !== "goal")) {
			this.rejectInput();
			return sources;
		}
		this.consume("goal");
		this.goalDeferred = false;
		this.releaseBarrier = false;
		if (this.resumeId) this.recordResume("settled");
		this.resumeId = undefined;
		this.released = [];
		return sources;
	}

	private showNotice(): void {
		this.notify(this.notices.noticeText());
	}

	private recordResume(phase: Extract<HoldEntry, { op: "resume" }>["phase"]): void {
		this.append("session-hold", {
			op: "resume",
			resumeId: this.resumeId!,
			pauseSeq: this.pauseSeq,
			phase,
			at: new Date().toISOString(),
		} satisfies HoldEntry);
	}
}
