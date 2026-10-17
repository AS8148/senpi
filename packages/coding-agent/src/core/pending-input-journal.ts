import { open } from "node:fs/promises";
import { dirname } from "node:path";
import {
	PENDING_INPUT_TRANSITION,
	type PendingInputJournal,
	type PendingInputJournalRecord,
} from "./pending-input-store.ts";
import type { PendingInput, PendingInputOperationResult } from "./pending-input-types.ts";
import type { SessionManager } from "./session-manager.ts";

type JournalSession = Pick<
	SessionManager,
	"appendCustomEntry" | "persistHeaderNow" | "getEntries" | "getSessionFile" | "isPersisted" | "isTranscriptFlushed"
>;

/** How the journal makes an append durable: the file's data, and once the directory entry that names it. */
export interface JournalDurability {
	syncFile(path: string): Promise<void>;
	syncDirectory(path: string): Promise<void>;
}

export const fsJournalDurability: JournalDurability = {
	syncFile: (path) => syncPath(path),
	syncDirectory: (path) => syncPath(path),
};

/**
 * The session JSONL as the pending-input journal (senpi#3549): each transition is one `custom` entry,
 * on disk and synced before the store publishes or dispatches it, even before the session's first message.
 */
export class SessionPendingInputJournal implements PendingInputJournal {
	private readonly session: JournalSession;
	private readonly durability: JournalDurability;
	private directorySynced = false;

	constructor(session: JournalSession, durability: JournalDurability = fsJournalDurability) {
		this.session = session;
		this.durability = durability;
	}

	/**
	 * A session opened without persistence (--no-session) keeps the journal in memory only, like the rest of
	 * that session. A persisted session must have its file on disk before the entry counts: the header is
	 * forced, the entry must reach the file itself (not the pre-conversation buffer), and the file and, once,
	 * its directory are synced before this returns.
	 */
	async append(record: PendingInputJournalRecord): Promise<void> {
		if (!this.session.isPersisted()) {
			this.session.appendCustomEntry(PENDING_INPUT_TRANSITION, record);
			return;
		}
		await this.session.persistHeaderNow();
		const file = this.session.getSessionFile();
		if (file === undefined || !this.session.isTranscriptFlushed()) throw new PendingInputNotDurableError();
		this.session.appendCustomEntry(PENDING_INPUT_TRANSITION, record);
		await this.durability.syncFile(file);
		if (!this.directorySynced) {
			await this.durability.syncDirectory(dirname(file));
			this.directorySynced = true;
		}
	}

	async read(): Promise<readonly PendingInputJournalRecord[]> {
		const records: PendingInputJournalRecord[] = [];
		for (const entry of this.session.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== PENDING_INPUT_TRANSITION) continue;
			records.push(parseRecord(entry.data, entry.id));
		}
		records.sort((a, b) => a.cursor - b.cursor);
		// The session loader skips a line that does not parse, so a lost transition shows only as a cursor gap.
		records.forEach((record, index) => {
			if (record.cursor !== index + 1) throw new PendingInputJournalGapError(index + 1);
		});
		return records;
	}
}

export class PendingInputNotDurableError extends Error {
	readonly code = "pending_input_journal_not_durable";
	constructor() {
		super("The session file is not on disk yet, so a pending input cannot be saved; try again.");
		this.name = "PendingInputNotDurableError";
	}
}

export class PendingInputJournalGapError extends Error {
	readonly code = "pending_input_journal_gap";
	constructor(missingCursor: number) {
		super(
			`Pending input journal is missing transition ${missingCursor}; the session cannot recover its queued input safely.`,
		);
		this.name = "PendingInputJournalGapError";
	}
}

async function syncPath(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
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
