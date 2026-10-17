import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("records a cleared identified input as removed, so it is neither delivered nor restored", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("drop on stop", undefined, { clientMessageId: "c-1" });

		const cleared = harness.session.clearQueue();
		await harness.session.whenQueueClearRecorded();
		release();
		await run;
		await harness.session.restoreQueuedInput({
			clientMessageId: "c-1",
			text: "drop on stop",
			mode: "followUp",
			enqueueOrder: 1,
		});

		expect(cleared.ordered.map((input) => input.text)).toEqual(["drop on stop"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "removed"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(harness.session.getQueuedInputs()).toEqual([]);
	});

	it("edits an identified input held back after a compaction and delivers the edit once released (T26, T27)", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("after follow-up")]);
		const internals = harness.session as unknown as {
			_promptStartPending: boolean;
			_skipNextPostCompactionAssistantCheck: boolean;
			_flushPostCompactionDeferredMessages(): void;
		};
		internals._promptStartPending = true;
		internals._skipNextPostCompactionAssistantCheck = true;
		await harness.session.followUp("held draft", undefined, { clientMessageId: "c-1" });
		const queuedId = harness.session.getQueuedInputs()[0]?.queuedId ?? "";

		const answer = await harness.session.changeQueuedInput(queuedId, "held final", { expectedRevision: 1 });
		internals._promptStartPending = false;
		internals._skipNextPostCompactionAssistantCheck = false;
		internals._flushPostCompactionDeferredMessages();
		await harness.session.prompt("go");

		expect(answer).toBe("edited");
		expect(getUserTexts(harness)).toEqual(["go", "held final"]);
		expect(phases(harness, "c-1")).toEqual(["queued", "queued", "sending", "delivered"]);
	});

	it("keeps the legacy queue path (the TUI's until P2c) exactly as before: sync answers, no journal, no events", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const updates: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "pending_input_update") updates.push(event);
		});
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("one");
		await harness.session.followUp("two");
		await harness.session.steer("three");
		const [one, two] = harness.session.getQueuedInputs();

		const edited = harness.session.editQueuedInput(one?.queuedId ?? "", "one edited", { expectedRevision: 1 });
		const removed = harness.session.dequeueQueuedInput(two?.queuedId ?? "");
		const stale = harness.session.editQueuedInput(one?.queuedId ?? "", "late", { expectedRevision: 1 });
		const cleared = harness.session.clearQueue();
		await harness.session.whenQueueClearRecorded();
		release();
		await run;

		expect([edited, removed, stale]).toEqual(["edited", "removed", "conflict"]);
		expect(cleared).toEqual({ steering: ["three"], followUp: ["one edited"] });
		expect(cleared.ordered.map((input) => input.text)).toEqual(["one edited", "three"]);
		expect(getUserTexts(harness)).toEqual(["start"]);
		expect(updates).toEqual([]);
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === PENDING_INPUT_TRANSITION),
		).toBe(false);
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

describe("pending-input recovery on reopen", () => {
	const dirs: string[] = [];
	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	function sessionDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pending-recovery-"));
		dirs.push(dir);
		return dir;
	}

	function inputsOver(sessionManager: SessionManager): SessionPendingInputs {
		let queuedIds = 100;
		return new SessionPendingInputs({ sessionManager, nextQueuedId: () => `q_${++queuedIds}` });
	}

	it("recovers a queued input and an attempt cut off before delivery, and retires a delivered one", async () => {
		const dir = sessionDir();
		const first = SessionManager.create(dir, dir);
		const before = inputsOver(first);
		await before.admit({ clientMessageId: "queued", text: "q", mode: "followUp" }, () => undefined);
		await before.admit({ clientMessageId: "cut", text: "c", mode: "followUp" }, () => undefined);
		await before.admit({ clientMessageId: "done", text: "d", mode: "followUp" }, () => undefined);
		const port = before.queuedInputPort();
		const user = (clientMessageId: string) => ({
			role: "user" as const,
			content: "x",
			timestamp: 1,
			clientMessageId,
		});
		const cut = user("cut");
		const done = user("done");
		await port.claim("followUp", () => [cut, done]);
		await port.commitConsumption("followUp", [done]);

		const after = inputsOver(SessionManager.open(first.getSessionFile() ?? "", dir));

		expect(await after.restoreHandle("queued")).toEqual({ queuedId: expect.stringMatching(/^q_/) });
		expect(await after.restoreHandle("cut")).toEqual({ queuedId: expect.stringMatching(/^q_/) });
		expect(await after.restoreHandle("done")).toBe("retired");
		expect(await after.restoreHandle("never-admitted")).toBeUndefined();
	});

	it("does not queue a restored input its record already delivered", async () => {
		const { harness, release, toolStarted } = await runWithHeldTool();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled"),
		]);
		const run = harness.session.prompt("start");
		await toolStarted;
		await harness.session.followUp("once", undefined, { clientMessageId: "c-1" });
		release();
		await run;

		await harness.session.restoreQueuedInput({
			clientMessageId: "c-1",
			text: "once",
			mode: "followUp",
			enqueueOrder: 1,
		});

		expect(harness.session.getQueuedInputs()).toEqual([]);
	});
});
