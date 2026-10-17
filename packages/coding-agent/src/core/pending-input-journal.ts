import { open } from "node:fs/promises";
import {
	PENDING_INPUT_TRANSITION,
	type PendingInputJournal,
	type PendingInputJournalRecord,
} from "./pending-input-store.ts";
import type { PendingInput, PendingInputOperationResult } from "./pending-input-types.ts";
import type { SessionManager } from "./session-manager.ts";

type JournalSession = Pick<SessionManager, "appendCustomEntry" | "persistHeaderNow" | "getEntries" | "getSessionFile">;

/**
 * The session JSONL as the pending-input journal (senpi#3549): each transition is one `custom` entry,
 * on disk and synced before the store publishes or dispatches it, even before the session's first message.
 */
export class SessionPendingInputJournal implements PendingInputJournal {
	private readonly session: JournalSession;

	constructor(session: JournalSession) {
		this.session = session;
	}

	async append(record: PendingInputJournalRecord): Promise<void> {
		await this.session.persistHeaderNow();
		this.session.appendCustomEntry(PENDING_INPUT_TRANSITION, record);
		const file = this.session.getSessionFile();
		if (file === undefined) return;
		const handle = await open(file, "r");
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
	}

	async read(): Promise<readonly PendingInputJournalRecord[]> {
		const records: PendingInputJournalRecord[] = [];
		for (const entry of this.session.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== PENDING_INPUT_TRANSITION) continue;
			records.push(parseRecord(entry.data, entry.id));
		}
		return records.sort((a, b) => a.cursor - b.cursor);
	}
}

export class PendingInputJournalError extends Error {
	readonly code = "pending_input_journal_invalid";
	constructor(entryId: string) {
		super(`Pending input journal entry ${entryId} is malformed; the session cannot recover its queued input safely.`);
		this.name = "PendingInputJournalError";
	}
}

function parseRecord(data: unknown, entryId: string): PendingInputJournalRecord {
	if (
		typeof data !== "object" ||
		data === null ||
		!("type" in data && data.type === PENDING_INPUT_TRANSITION) ||
		!("cursor" in data && typeof data.cursor === "number") ||
		!("input" in data && isPendingInput(data.input))
	) {
		throw new PendingInputJournalError(entryId);
	}
	const result = "result" in data ? data.result : undefined;
	if (result !== undefined && !isOperationResult(result)) throw new PendingInputJournalError(entryId);
	return {
		type: PENDING_INPUT_TRANSITION,
		cursor: data.cursor,
		input: data.input,
		...(result === undefined ? {} : { result }),
	};
}

function isOperationResult(value: unknown): value is PendingInputOperationResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"outcome" in value &&
		typeof value.outcome === "string" &&
		"clientMessageId" in value &&
		typeof value.clientMessageId === "string"
	);
}

function isPendingInput(value: unknown): value is PendingInput {
	return (
		typeof value === "object" &&
		value !== null &&
		"clientMessageId" in value &&
		typeof value.clientMessageId === "string" &&
		"phase" in value &&
		typeof value.phase === "string" &&
		"handle" in value &&
		typeof value.handle === "object" &&
		"revision" in value &&
		typeof value.revision === "number"
	);
}
