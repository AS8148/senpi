import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ClientMessageIdConflictError, SessionPendingInputs } from "../../src/core/pending-input-session.ts";
import {
	PENDING_INPUT_TRANSITION,
	type PendingInputJournal,
	type PendingInputJournalRecord,
} from "../../src/core/pending-input-store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

// senpi#3549: AgentSession admits identified queued input into durable custody and delivers it through the port.

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

async function runWithHeldTool() {
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await held;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const harness = await createHarness({ tools: [waitTool] });
	harnesses.push(harness);
	const toolStarted = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				unsubscribe();
				resolve();
			}
		});
	});
	return { harness, release, toolStarted };
}

function phases(harness: Harness, clientMessageId: string): string[] {
	return harness.session.sessionManager
		.getEntries()
		.flatMap((entry) =>
			entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION ? [entry.data] : [],
		)
		.filter((data): data is PendingInputJournalRecord => (data as PendingInputJournalRecord).input !== undefined)
		.filter((record) => record.input.clientMessageId === clientMessageId)
		.map((record) => record.input.phase);
}

describe("AgentSession pending inputs", () => {
	it("journals an identified steer as delivered before the request that carries it", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		const phasesAtRequest: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			() => {
				phasesAtRequest.push(phases(harness, "c-1"));
				return fauxAssistantMessage("handled");
			},
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.steer("look here", undefined, { clientMessageId: "c-1" });
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "look here"]);
		expect(phasesAtRequest).toEqual([["queued", "sending", "delivered"]]);
	});

	it("queues a repeated identical submit once", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.followUp("once", undefined, { clientMessageId: "c-1" });
		await harness.session.followUp("once", undefined, { clientMessageId: "c-1" });
		expect(harness.session.getQueuedInputs().map((input) => input.text)).toEqual(["once"]);
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "once"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "sending", "delivered"]);
	});

	it("refuses a reused client id with another payload and queues nothing for it", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("first", undefined, { clientMessageId: "c-1" });

		await expect(harness.session.followUp("second", undefined, { clientMessageId: "c-1" })).rejects.toBeInstanceOf(
			ClientMessageIdConflictError,
		);
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "first"]);
	});

	it("delivers the edited text of an identified input and records the edit before it", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("draft", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		const answer = await harness.session.changeQueuedInput(queuedId, "final", { expectedRevision: 1 });
		release();
		await run;

		expect(answer).toBe("edited");
		expect(getUserTexts(harness)).toEqual(["start", "final"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "queued", "sending", "delivered"]);
	});

	it("removes an identified input from its record and the queue, so it is never delivered", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("drop me", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		const answer = await harness.session.changeQueuedInput(queuedId, undefined);
		release();
		await run;

		expect(answer).toBe("removed");
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "removed"]);
	});

	it("answers conflict for a stale revision and changes neither the record nor the queue", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("v1", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";
		await harness.session.changeQueuedInput(queuedId, "v2", { expectedRevision: 1 });

		const answer = await harness.session.changeQueuedInput(queuedId, "stale", { expectedRevision: 1 });

		expect(answer).toBe("conflict");
		expect(harness.session.getQueuedInputs().map((input) => input.text)).toEqual(["v2"]);
		release();
		await run;
		expect(getUserTexts(harness)).toEqual(["start", "v2"]);
	});

	it("keeps input without a client id out of the journal", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;

		await harness.session.followUp("plain");
		release();
		await run;

		expect(getUserTexts(harness)).toEqual(["start", "plain"]);
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION),
		).toBe(false);
	});
});

describe("SessionPendingInputs.change", () => {
	it("leaves the native queue alone when the record of the change cannot be saved", async () => {
		const records: PendingInputJournalRecord[] = [];
		let failNext = false;
		const journal: PendingInputJournal = {
			append: async (record) => {
				if (failNext) throw new Error("disk full");
				records.push(record);
			},
			read: async () => records,
		};
		let queuedIds = 0;
		const inputs = new SessionPendingInputs({
			sessionManager: SessionManager.inMemory(),
			nextQueuedId: () => `q_${++queuedIds}`,
			journal,
		});
		await inputs.admit({ clientMessageId: "c-1", text: "draft", mode: "followUp" }, () => undefined);
		let nativeChanged = false;
		failNext = true;

		await expect(
			inputs.change({ clientMessageId: "c-1", text: "final" }, () => {
				nativeChanged = true;
				return "edited";
			}),
		).rejects.toThrow("disk full");
		expect(nativeChanged).toBe(false);
	});
});
