import type { CustomMessage } from "./messages.ts";
import type { SessionEntry } from "./session-manager.ts";

type HeldWake = { noticeIds: string[]; message?: CustomMessage };
interface HeldNotice {
	noticeId: string;
	producer: string;
	pauseSeq: number;
	at: string;
	heldCount: number;
	text: string;
	action: "resume_session";
	message?: CustomMessage;
}

/** Durable notice custody, retaining only the latest model payload for each source. */
export class EngineTurnHoldNotices {
	private wakes: Record<string, HeldWake> = Object.create(null);
	private readonly append: (type: string, data: unknown) => void;

	constructor(entries: readonly SessionEntry[], append: (type: string, data: unknown) => void) {
		this.append = append;
		for (const entry of entries) {
			if (entry.type !== "custom") continue;
			if (entry.customType === "session-notice") {
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

	get sources(): Record<string, number> {
		return Object.fromEntries(Object.entries(this.wakes).map(([source, wake]) => [source, wake.noticeIds.length]));
	}

	get noticeCount(): number {
		return Object.values(this.sources).reduce((sum, count) => sum + count, 0);
	}

	noticeText(count = this.noticeCount): string {
		return `Goal paused while no one was here: ${count} automatic wakes held. Resume or send a message to continue.`;
	}

	note(source: string, pauseSeq: number, message?: CustomMessage): void {
		const data: HeldNotice = {
			noticeId: crypto.randomUUID(),
			producer: source,
			pauseSeq,
			at: new Date().toISOString(),
			heldCount: this.noticeCount + 1,
			text: this.noticeText(this.noticeCount + 1),
			action: "resume_session",
			...(source !== "goal" && message ? { message } : {}),
		};
		this.append("session-notice", data);
		this.remember(data);
	}

	messages(): Array<{ source: string; noticeIds: readonly string[]; message: CustomMessage }> {
		return Object.entries(this.wakes).flatMap(([source, wake]) => {
			if (source === "goal" || !wake.message) return [];
			const message = wake.message;
			const noticeIds = [...wake.noticeIds];
			if (source !== "monitor") return [{ source, noticeIds, message }];
			const prefix = `${wake.noticeIds.length} automatic monitor wakes held. Latest event:\n`;
			return [
				{
					source,
					noticeIds,
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

	consume(source: string, pauseSeq: number, deliveredIds?: readonly string[]): void {
		const wake = this.wakes[source];
		if (!wake) return;
		const delivered = new Set(deliveredIds ?? wake.noticeIds);
		const noticeIds = wake.noticeIds.filter((id) => delivered.has(id));
		if (noticeIds.length === 0) return;
		this.append("session-notices-consumed", { noticeIds, inputIds: [], pauseSeq });
		wake.noticeIds = wake.noticeIds.filter((id) => !delivered.has(id));
		if (wake.noticeIds.length === 0) delete this.wakes[source];
	}

	private remember(notice: HeldNotice): void {
		const wake = this.wakes[notice.producer] ?? { noticeIds: [] };
		wake.noticeIds.push(notice.noticeId);
		if (notice.message) wake.message = notice.message;
		this.wakes[notice.producer] = wake;
	}
}
