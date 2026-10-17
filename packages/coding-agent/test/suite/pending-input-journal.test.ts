import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PendingInputJournalError, SessionPendingInputJournal } from "../../src/core/pending-input-journal.ts";
import { PENDING_INPUT_TRANSITION, PendingInputStore } from "../../src/core/pending-input-store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

// senpi#3549: the session JSONL is the pending-input journal; admission is on disk before the first message.

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

function sessionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pending-journal-"));
	dirs.push(dir);
	return dir;
}

const SUBMIT = {
	clientMessageId: "c-1",
	fingerprint: "fp",
	text: "check the logs",
	attachments: [],
	requestedMode: "followUp",
} as const;

async function storeOver(manager: SessionManager, lifetimeId: string): Promise<PendingInputStore> {
	let next = 0;
	return PendingInputStore.open({
		journal: new SessionPendingInputJournal(manager),
		lifetimeId,
		nextQueuedId: () => `q_${++next}`,
	});
}

describe("session pending-input journal", () => {
	it("puts an admission on disk before the session has any message", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		const store = await storeOver(manager, "life-1");

		await store.submit(SUBMIT);

		const file = manager.getSessionFile() ?? "";
		const onDisk = readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(
			onDisk.some(
				(entry) => entry.customType === PENDING_INPUT_TRANSITION && entry.data.input.clientMessageId === "c-1",
			),
		).toBe(true);
	});

	it("rebuilds custody and edits from the file after a reopen", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		const store = await storeOver(manager, "life-1");
		await store.submit(SUBMIT);
		await store.apply("c-1", {
			type: "edit",
			effectId: "e1",
			handle: { lifetimeId: "life-1", queuedId: "q_1" },
			expectedRevision: 1,
			text: "edited",
			attachments: [],
		});

		const reopened = await storeOver(SessionManager.open(manager.getSessionFile() ?? "", dir), "life-2");

		expect(reopened.read("c-1")).toMatchObject({
			status: "admitted",
			projection: { state: "edited", text: "edited", revision: 1 },
		});
	});

	it("refuses a malformed journal entry instead of treating it as absence", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		await manager.persistHeaderNow();
		manager.appendCustomEntry(PENDING_INPUT_TRANSITION, { type: PENDING_INPUT_TRANSITION, cursor: 1 });

		await expect(new SessionPendingInputJournal(manager).read()).rejects.toBeInstanceOf(PendingInputJournalError);
	});
});
