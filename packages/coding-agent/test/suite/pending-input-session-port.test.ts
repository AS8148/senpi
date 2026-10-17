import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createSessionQueuedInputPort } from "../../src/core/pending-input-session-port.ts";
import type { PendingInputJournal, PendingInputJournalRecord } from "../../src/core/pending-input-store.ts";
import { PendingInputStore } from "../../src/core/pending-input-store.ts";
import type { PendingInputPhase } from "../../src/core/pending-input-types.ts";

// senpi#3549: the session's queued-input port over a real Agent and the store (plan E2, T05, T06, T28).

class MemoryJournal implements PendingInputJournal {
	readonly records: PendingInputJournalRecord[] = [];
	failWhen: ((record: PendingInputJournalRecord) => boolean) | undefined;
	async append(record: PendingInputJournalRecord): Promise<void> {
		if (this.failWhen?.(record)) throw new Error("journal unavailable");
		this.records.push(record);
	}
	async read(): Promise<readonly PendingInputJournalRecord[]> {
		return [...this.records];
	}
	phases(clientMessageId: string): PendingInputPhase[] {
		return this.records.filter((r) => r.input.clientMessageId === clientMessageId).map((r) => r.input.phase);
	}
}

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function queuedUser(text: string, clientMessageId?: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now(), ...(clientMessageId ? { clientMessageId } : {}) };
}

function texts(messages: readonly AgentMessage[]): string {
	return messages
		.flatMap((message) => {
			if (message.role !== "user") return [];
			if (typeof message.content === "string") return [message.content];
			return [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
		})
		.join("|");
}

async function setup() {
	const journal = new MemoryJournal();
	let queuedIds = 0;
	let attemptIds = 0;
	const store = await PendingInputStore.open({
		journal,
		lifetimeId: "life-1",
		nextQueuedId: () => `q_${++queuedIds}`,
	});
	const requests: { texts: string; phases: PendingInputPhase[] }[] = [];
	const streamFn: StreamFn = (_model, context) => {
		requests.push({ texts: texts(context.messages), phases: journal.phases("c-1") });
		const stream = new MockAssistantStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant() }));
		return stream;
	};
	const port = createSessionQueuedInputPort({
		store,
		ownerId: "owner-1",
		writerGeneration: 1,
		nextAttemptId: () => `a-${++attemptIds}`,
	});
	const agent = new Agent({ streamFn, queuedInputPort: port });
	return { journal, store, agent, requests };
}

const SUBMIT = {
	clientMessageId: "c-1",
	fingerprint: "fp",
	text: "later",
	attachments: [],
	requestedMode: "followUp",
} as const;

describe("session queued-input port", () => {
	it("journals the reservation and the consumption before the provider sees the input", async () => {
		const { journal, store, agent, requests } = await setup();
		await store.submit(SUBMIT);
		agent.followUp(queuedUser("later", "c-1"));

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first", "first|later"]);
		expect(requests[1]?.phases).toEqual(["queued", "sending", "delivered"]);
		expect(store.read("c-1")).toMatchObject({ status: "admitted", projection: { state: "delivered" } });
		expect(journal.phases("c-1")).toEqual(["queued", "sending", "delivered"]);
	});

	it("does not deliver a native copy the store already removed", async () => {
		const { store, agent, requests } = await setup();
		await store.submit(SUBMIT);
		await store.apply("c-1", {
			type: "remove",
			effectId: "e-1",
			handle: { lifetimeId: "life-1", queuedId: "q_1" },
			expectedRevision: 1,
		});
		agent.followUp(queuedUser("later", "c-1"));

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first"]);
		expect(store.read("c-1")).toMatchObject({ projection: { state: "removed" } });
	});

	it("returns a claimed input to its queue, same id, when its consumption cannot be committed (T28)", async () => {
		const { journal, store, agent, requests } = await setup();
		await store.submit(SUBMIT);
		agent.followUp(queuedUser("later", "c-1"));
		journal.failWhen = (record) => record.input.phase === "delivered";

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first"]);
		expect(journal.phases("c-1")).toEqual(["queued", "sending", "queued"]);
		expect(store.read("c-1")).toMatchObject({ projection: { state: "queued" } });
		expect(texts(agent.peekQueuedMessages())).toBe("later");
	});

	it("passes input the store never admitted straight through", async () => {
		const { journal, agent, requests } = await setup();
		agent.followUp(queuedUser("legacy"));

		await agent.prompt("first");

		expect(requests.map((request) => request.texts)).toEqual(["first", "first|legacy"]);
		expect(journal.records).toEqual([]);
	});
});
