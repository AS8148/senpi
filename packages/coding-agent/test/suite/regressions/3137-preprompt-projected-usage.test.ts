import {
	estimateContextTokens as estimatePromptTokens,
	fauxAssistantMessage,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateProjectedContextTokens } from "../../../src/core/compaction/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-12T00:00:00Z"));
});

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.useRealTimers();
});

function answerWithUsage(input: number) {
	const answer = fauxAssistantMessage("answer", { timestamp: Date.now() });
	return { ...answer, usage: { ...answer.usage, input, totalTokens: input } };
}

async function setup(contextWindow = 400_000, outcome: "accept" | "fail" | "reject" | "abort" = "accept") {
	let boundary = "";
	const attempts: string[] = [];
	const harness = await createHarness({
		models: [{ id: "preprompt-projection", contextWindow, maxTokens: 4_000 }],
		settings: {
			compaction: {
				enabled: true,
				speculativeEnabled: false,
				idleCompactionEnabled: false,
				keepRecentTokens: 2_000,
				reserveTokens: 20_000,
				reserveScalingEnabled: false,
			},
			retry: { enabled: false },
		},
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event) => {
					attempts.push(event.reason);
					if (event.reason !== "manual" || outcome === "reject") {
						return { cancel: true, rejectionCause: "cancelled-by-extension", reason: "refused" };
					}
					if (outcome === "fail") throw new Error("summary generation failed");
					if (outcome === "abort") {
						harness.session.abortCompaction();
						return { cancel: true };
					}
					return {
						compaction: {
							summary: "compact summary",
							firstKeptEntryId: boundary,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
		],
	});
	harnesses.push(harness);
	const oldId = harness.sessionManager.appendMessage({
		role: "user",
		content: "old context ".repeat(40_000),
		timestamp: Date.now(),
	});
	for (let index = 0; index < 20; index++) {
		harness.sessionManager.appendMessage(fauxAssistantMessage("historical reply ".repeat(500)));
	}
	boundary = harness.sessionManager.appendMessage({
		role: "user",
		content: "retained request",
		timestamp: Date.now(),
	});
	const stale = answerWithUsage(contextWindow - 19_000);
	harness.sessionManager.appendMessage(stale);
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	await harness.session.bindExtensions({});
	return { harness, attempts, stale, oldId };
}

function addTail(harness: Harness, text = "extension note"): void {
	harness.sessionManager.appendMessage({
		role: "custom",
		customType: "extension-note",
		content: text,
		display: false,
		timestamp: Date.now(),
	});
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function prePromptTokens(harness: Harness): unknown {
	const estimate = Reflect.get(harness.session, "_estimatePrePromptContextTokens");
	if (typeof estimate !== "function") throw new Error("Missing pre-prompt estimator");
	return estimate.call(harness.session);
}

describe("#3137: pre-prompt admission uses current projected context", () => {
	it.each([400_000, 500_000])("reaches the provider with an extension tail after compaction at %i", async (window) => {
		// Given: an accepted checkpoint retains a tiny reply with old, over-limit usage.
		const { harness, attempts } = await setup(window);
		await harness.session.compact();
		addTail(harness);
		harness.setResponses([answerWithUsage(1_000)]);

		// When: a real prompt passes both pre-provider admission gates.
		await harness.session.prompt("continue");

		// Then: no second compaction or local refusal prevents the provider call.
		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual(["manual"]);
	});

	it("still admits the same compacted context without an extension tail", async () => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		harness.setResponses([answerWithUsage(1_000)]);

		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual(["manual"]);
	});

	it.each(["fail", "reject", "abort"] as const)("keeps old usage and refuses when compaction %ss", async (outcome) => {
		const { harness } = await setup(400_000, outcome);
		await expect(harness.session.compact()).rejects.toThrow();
		expect(harness.sessionManager.getBranch().some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			estimateProjectedContextTokens(
				harness.sessionManager.buildSessionProjection(),
				harness.sessionManager.getBranch(),
			).usageTokens,
		).toBeGreaterThanOrEqual(381_000);
		const callsBefore = harness.faux.getCallLog().length;

		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(callsBefore);
	});

	it.each([1_000, 381_000])("uses fresh provider usage of %i after compaction", async (input) => {
		const { harness, attempts } = await setup();
		await harness.session.compact();
		harness.sessionManager.appendMessage(answerWithUsage(input));
		addTail(harness);
		harness.setResponses([answerWithUsage(1_000)]);

		if (input === 381_000) {
			await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);
			expect(harness.faux.getCallLog()).toHaveLength(0);
			expect(attempts).toEqual(["manual", "pre_prompt"]);
		} else {
			await harness.session.prompt("continue");
			expect(harness.faux.getCallLog()).toHaveLength(1);
			expect(attempts).toEqual(["manual"]);
		}
	});

	it("does not recompact usage invalidated by a context edit in the inline threshold check", async () => {
		const { harness, attempts, oldId } = await setup();
		const leafId = harness.sessionManager.getLeafId();
		for (const entry of harness.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.id !== leafId) {
				harness.sessionManager.appendContextEdit(entry.id, null);
			}
		}
		expect(
			harness.sessionManager.getBranch().some((entry) => entry.type === "context_edit" && entry.targetId === oldId),
		).toBe(true);
		addTail(harness);
		harness.setResponses([answerWithUsage(1_000)]);

		await harness.session.prompt("continue");

		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual([]);
	});

	it("refuses truly oversized post-compaction custom content", async () => {
		const { harness } = await setup();
		await harness.session.compact();
		addTail(harness, "large tail ".repeat(160_000));

		await expect(harness.session.prompt("continue")).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(0);
	});

	it("counts the current system prompt and tool schemas once until fresh usage arrives", async () => {
		const { harness } = await setup();
		await harness.session.compact();
		harness.agent.state.systemPrompt = "system prefix ".repeat(1_000);
		harness.agent.state.tools = [
			{
				name: "sample",
				label: "Sample",
				description: "tool description ".repeat(1_000),
				parameters: Type.Object({ input: Type.String() }),
				execute: async () => ({ content: [{ type: "text", text: "result" }], details: {} }),
			},
		];
		const projected = estimateProjectedContextTokens(
			harness.sessionManager.buildSessionProjection(),
			harness.sessionManager.getBranch(),
		).tokens;
		const prefix = estimatePromptTokens(
			normalizeContext({
				systemPrompt: harness.agent.state.systemPrompt,
				messages: [],
				tools: harness.agent.state.tools,
			}),
		).tokens;

		expect(prePromptTokens(harness)).toBe(projected + prefix);

		harness.sessionManager.appendMessage(answerWithUsage(20_000));
		harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		expect(prePromptTokens(harness)).toBe(20_000);
	});

	it("counts turn-local custom messages in final admission after a checkpoint", async () => {
		const { harness } = await setup();
		await harness.session.compact();
		const enforce = Reflect.get(harness.session, "_enforceFinalProviderAdmission");
		if (typeof enforce !== "function") throw new Error("Missing final provider admission");
		const tail = {
			role: "custom",
			customType: "next-turn-note",
			content: "large tail ".repeat(160_000),
			display: false,
			timestamp: Date.now(),
		};

		await expect(enforce.call(harness.session, [tail])).rejects.toThrow(/compaction threshold/);

		expect(harness.faux.getCallLog()).toHaveLength(0);
	});
});
