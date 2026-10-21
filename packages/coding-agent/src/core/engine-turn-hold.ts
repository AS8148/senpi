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
type HeldWake = { noticeIds: string[]; message?: CustomMessage };
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
type HeldNotice = { noticeId: string; producer: string; pauseSeq: number; message?: CustomMessage };

export function engineWakeSource(customType: string): string {
	if (customType === "goal-continuation") return "goal";
	if (customType.startsWith("senpi-monitor:")) return "monitor";
	if (customType.startsWith("senpi-codemode:")) return "codemode";
	return customType;
}

/** One session-scoped hold ledger and notice custody point, independent of the transcript leaf. */
export class EngineTurnHold {
	private records = new Map<string, SessionHold>();
	private wakes: Record<string, HeldWake> = Object.create(null);
	private pauseSeq = 0;
	private resumeId: string | undefined;
	private released: SessionHold[] = [];
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
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "session-hold") {
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
			} else if (entry.customType === "session-notice") {
				this.remember(entry.data as HeldNotice);
			} else if (entry.customType === "session-notices-consumed") {
				const ids = new Set((entry.data as { noticeIds: string[] }).noticeIds);
				for (const [source, wake] of Object.entries(this.wakes)) {
					wake.noticeIds = wake.noticeIds.filter((id) => !ids.has(id));
					if (wake.noticeIds.length === 0) delete this.wakes[source];
				}
			}
		}
	}

	isHeld(): boolean {
		return this.records.size > 0;
	}

	get held(): boolean {
		return this.isHeld();
	}

	get holds(): SessionHold[] {
		return [...this.records.values()].map((hold) => ({ ...hold, sourceCounts: this.sources }));
	}

	get sources(): Record<string, number> {
		return Object.fromEntries(Object.entries(this.wakes).map(([source, wake]) => [source, wake.noticeIds.length]));
	}

	get noticeCount(): number {
		return Object.values(this.sources).reduce((sum, count) => sum + count, 0);
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

	holdsSource(source: string): boolean {
		return this.isHeld() || (source === "goal" && this.goalDeferred);
	}

	note(source: string, message?: CustomMessage): void {
		const data: HeldNotice = {
			noticeId: crypto.randomUUID(),
			producer: source,
			pauseSeq: this.pauseSeq,
			...(source !== "goal" && message ? { message } : {}),
		};
		this.append("session-notice", data);
		this.remember(data);
		this.showNotice();
	}

	messages(): Array<{ source: string; message: CustomMessage }> {
		return Object.entries(this.wakes).flatMap(([source, wake]) => {
			if (source === "goal" || !wake.message) return [];
			const message = wake.message;
			if (source !== "monitor") return [{ source, message }];
			const prefix = `${wake.noticeIds.length} automatic monitor wakes held. Latest event:\n`;
			return [
				{
					source,
					message: {
						...message,
						content:
							typeof message.content === "string"
								? prefix + message.content
								: [{ type: "text" as const, text: prefix }, ...message.content],
					},
				},
			];
		});
	}

	releaseAll(cause: HoldReleaseCause): Record<string, number> {
		const sources = this.sources;
		if (!this.isHeld()) return sources;
		this.generation++;
		this.released = this.holds;
		this.resumeId = crypto.randomUUID();
		this.recordResume("requested");
		const at = new Date().toISOString();
		this.append("session-hold", {
			op: "release",
			keys: [...this.records.keys()],
			observedSeq: this.pauseSeq,
			cause,
			at,
		} satisfies HoldEntry);
		this.records.clear();
		this.goalDeferred = (sources.goal ?? 0) > 0;
		this.emit({ type: "session_resumed", pauseSeq: this.pauseSeq, cause, at });
		this.recordResume("delivery_pending");
		return sources;
	}

	rejectInput(): void {
		this.goalDeferred = false;
		for (const { kind, key, data } of this.released) this.addHold(kind, { key, data });
	}

	consume(source: string): void {
		const wake = this.wakes[source];
		if (!wake) return;
		this.append("session-notices-consumed", { noticeIds: wake.noticeIds, inputIds: [], pauseSeq: this.pauseSeq });
		delete this.wakes[source];
	}

	finish(): Record<string, number> {
		const sources = this.sources;
		for (const source of Object.keys(sources)) this.consume(source);
		this.goalDeferred = false;
		if (this.resumeId) this.recordResume("settled");
		this.resumeId = undefined;
		this.released = [];
		return sources;
	}

	private remember(notice: HeldNotice): void {
		const wake = this.wakes[notice.producer] ?? { noticeIds: [] };
		wake.noticeIds.push(notice.noticeId);
		if (notice.message) wake.message = notice.message;
		this.wakes[notice.producer] = wake;
	}

	private showNotice(): void {
		this.notify(
			`Goal paused while no one was here: ${this.noticeCount} automatic wakes held. Resume or send a message to continue.`,
		);
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
