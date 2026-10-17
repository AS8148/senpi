import { describe, expect, it } from "vitest";
import type { PendingInputJournal, PendingInputJournalRecord } from "../../src/core/pending-input-store.ts";
import { PendingInputStore } from "../../src/core/pending-input-store.ts";
import type { DeliveryToken } from "../../src/core/pending-input-types.ts";

// senpi#3549: the store commits one journal record per transition before publishing or dispatching (T-ids).

class MemoryJournal implements PendingInputJournal {
	readonly records: PendingInputJournalRecord[] = [];
	failNext = false;
	async append(record: PendingInputJournalRecord): Promise<void> {
		if (this.failNext) {
			this.failNext = false;
			throw new Error("disk full");
		}
		this.records.push(record);
	}
	async read(): Promise<readonly PendingInputJournalRecord[]> {
		return [...this.records];
	}
}

const SUBMIT = {
	clientMessageId: "c-1",
	fingerprint: "fp",
	text: "check the logs",
	attachments: [],
	requestedMode: "followUp",
} as const;

async function openStore(journal: MemoryJournal, lifetimeId = "life-1") {
	let next = 0;
	const dispatched: DeliveryToken[] = [];
	const drafts: string[] = [];
	const store = await PendingInputStore.open({
		journal,
		lifetimeId,
		nextQueuedId: () => `q_${++next}`,
		dispatch: (token) => dispatched.push(token),
		restoreToDraft: (text) => drafts.push(text),
	});
	return { store, dispatched, drafts };
}

describe("pending input store", () => {
	it("does not publish or dispatch an uncommitted transition (T40)", async () => {
		const journal = new MemoryJournal();
		const { store, dispatched } = await openStore(journal);
		await store.submit(SUBMIT);
		const seen: string[] = [];
		store.subscribe((projection) => seen.push(projection.state));
		journal.failNext = true;
		const token = {
			ownerId: "o",
			writerGeneration: 1,
			lifetimeId: "life-1",
			attemptId: "a-1",
			clientMessageId: "c-1",
		};

		await expect(store.apply("c-1", { type: "reserve", token })).rejects.toThrow("disk full");

		expect(store.read("c-1")).toMatchObject({ status: "admitted", projection: { state: "queued" } });
		expect(seen).toEqual([]);
		expect(dispatched).toEqual([]);
	});

	it("rebinds lifetime handles without losing text or edited history (T29)", async () => {
		const journal = new MemoryJournal();
		const { store } = await openStore(journal);
		await store.submit(SUBMIT);
		await store.apply("c-1", {
			type: "edit",
			effectId: "e1",
			handle: { lifetimeId: "life-1", queuedId: "q_1" },
			expectedRevision: 1,
			text: "edited",
			attachments: [],
		});

		const reopened = (await openStore(journal, "life-2")).store;

		expect(reopened.read("c-1")).toMatchObject({
			status: "admitted",
			projection: { state: "edited", revision: 1, text: "edited" },
		});
	});

	it("replays the complete original effect answer across reopen (T43)", async () => {
		const journal = new MemoryJournal();
		const { store } = await openStore(journal);
		await store.submit(SUBMIT);
		const edit = {
			type: "edit",
			effectId: "e1",
			handle: { lifetimeId: "life-1", queuedId: "q_1" },
			expectedRevision: 1,
			text: "edited",
			attachments: [],
		} as const;
		const live = await store.apply("c-1", edit);
		const stale = await store.apply("c-1", { ...edit, effectId: "e2", text: "stale" });

		const reopened = (await openStore(journal, "life-2")).store;

		expect(await reopened.apply("c-1", edit)).toEqual({ ...live, replayed: true });
		expect(await reopened.apply("c-1", { ...edit, effectId: "e2", text: "stale" })).toEqual({
			...stale,
			replayed: true,
		});
		expect(stale).toMatchObject({ outcome: "conflict", currentRevision: 2 });
	});

	it("answers unknown identity without inventing text or delivery (T36)", async () => {
		const { store } = await openStore(new MemoryJournal());

		expect(store.read("never-sent")).toEqual({ status: "not_admitted", clientMessageId: "never-sent" });
	});

	it("serializes concurrent edits on one revision into one winner and one conflict", async () => {
		const journal = new MemoryJournal();
		const { store } = await openStore(journal);
		await store.submit(SUBMIT);
		const handle = { lifetimeId: "life-1", queuedId: "q_1" };

		const [a, b] = await Promise.all([
			store.apply("c-1", {
				type: "edit",
				effectId: "a",
				handle,
				expectedRevision: 1,
				text: "from A",
				attachments: [],
			}),
			store.apply("c-1", {
				type: "edit",
				effectId: "b",
				handle,
				expectedRevision: 1,
				text: "from B",
				attachments: [],
			}),
		]);

		expect([a?.outcome, b?.outcome]).toEqual(["edited", "conflict"]);
		expect(store.read("c-1")).toMatchObject({ projection: { text: "from A", revision: 2 } });
	});

	it("reports partial Stop conflicts without dropping concurrent edits (T44)", async () => {
		const journal = new MemoryJournal();
		const { store, drafts } = await openStore(journal);
		await store.submit(SUBMIT);
		await store.submit({ ...SUBMIT, clientMessageId: "c-2", fingerprint: "fp2", text: "second" });
		await store.apply("c-2", {
			type: "edit",
			effectId: "e",
			handle: { lifetimeId: "life-1", queuedId: "q_2" },
			expectedRevision: 1,
			text: "second, edited",
			attachments: [],
		});

		const receipt = await store.stop(
			[
				{ clientMessageId: "c-1", handle: { lifetimeId: "life-1", queuedId: "q_1" }, expectedRevision: 1 },
				{ clientMessageId: "c-2", handle: { lifetimeId: "life-1", queuedId: "q_2" }, expectedRevision: 1 },
			],
			false,
		);

		expect(receipt).toEqual({
			removed: ["c-1"],
			conflicts: [{ clientMessageId: "c-2", currentRevision: 2 }],
			retained: [],
		});
		expect(drafts).toEqual([SUBMIT.text]);
		expect(store.read("c-2")).toMatchObject({ projection: { state: "edited", text: "second, edited" } });
	});

	it("dispatches only after the reservation is journaled", async () => {
		const journal = new MemoryJournal();
		const { store, dispatched } = await openStore(journal);
		await store.submit(SUBMIT);
		const token = {
			ownerId: "o",
			writerGeneration: 1,
			lifetimeId: "life-1",
			attemptId: "a-1",
			clientMessageId: "c-1",
		};

		await store.apply("c-1", { type: "reserve", token });

		expect(dispatched).toEqual([token]);
		expect(journal.records.at(-1)?.input.phase).toBe("sending");
	});
});
