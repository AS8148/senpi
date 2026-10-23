import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const FIRST_PROMPT = "first prompt after the compaction";
const STEER = "steer queued around the first prompt after the compaction";

type PromptStartHook = (prompt: string) => Promise<void>;

async function createAcceptedCompactionHarness(thresholdCompactionEnabled: boolean, onPromptStarting: PromptStartHook) {
	return createHarness({
		models: [{ id: "issue-4036-spent", contextWindow: 128_000, maxTokens: 64 }],
		settings: { compaction: { enabled: thresholdCompactionEnabled, reserveTokens: 16_384, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event) => ({
					compaction: {
						summary: "accepted summary",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
				pi.on("before_agent_start", (event) => onPromptStarting(event.prompt));
			},
		],
	});
}

async function seedAndCompact(harness: Harness): Promise<void> {
	harness.setResponses([fauxAssistantMessage("seed response")]);
	await harness.session.prompt("seed context ".repeat(40));
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") throw new Error("Expected AgentSession._runAutoCompaction");
	await runAutoCompaction.call(harness.session, "threshold", false);
	expect(harness.eventsOfType("compaction_end")).toEqual([expect.objectContaining({ accepted: true })]);
}

async function settle(harness: Harness): Promise<void> {
	await harness.session.waitForIdle();
	await harness.session.waitForSettledSessionWork();
}

function steerDeliveries(harness: Harness): number {
	return getUserTexts(harness).filter((text) => text === STEER).length;
}

describe("#4036 every way the first post-compaction response can end releases the input it held", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given threshold compaction off #when the first response stops on its length limit #then a steer sent while it started is delivered in that run", async () => {
		// given
		const promptStarting = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		const harness = await createAcceptedCompactionHarness(false, async (prompt) => {
			if (prompt !== FIRST_PROMPT) return;
			promptStarting.resolve();
			await releasePrompt.promise;
		});
		harnesses.push(harness);
		await seedAndCompact(harness);
		harness.setResponses([
			{ ...fauxAssistantMessage("response cut at its length limit"), stopReason: "length" },
			fauxAssistantMessage("steer handled"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		// when
		const prompt = harness.session.prompt(FIRST_PROMPT);
		await promptStarting.promise;
		await harness.session.prompt(STEER, { streamingBehavior: "steer" });
		releasePrompt.resolve();
		await prompt;
		await settle(harness);

		// then
		expect(steerDeliveries(harness)).toBe(1);
		expect(getAssistantTexts(harness)).toContain("steer handled");
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
	});

	it.each([
		{ thresholdCompaction: "disabled", enabled: false },
		{ thresholdCompaction: "enabled", enabled: true },
	])(
		"#given threshold compaction $thresholdCompaction #when the first response is aborted by the provider while a steer was sent during it #then prompt() does not fail with a required-compaction error",
		async ({ enabled }) => {
			// given
			const harness = await createAcceptedCompactionHarness(enabled, async () => {});
			harnesses.push(harness);
			await seedAndCompact(harness);
			let steered: Promise<unknown> | undefined;
			harness.setResponses([
				() => {
					steered = harness.session.prompt(STEER, { streamingBehavior: "steer" });
					return {
						...fauxAssistantMessage("aborted response after the compaction"),
						stopReason: "aborted",
						errorMessage: "provider stream aborted",
					};
				},
				fauxAssistantMessage("steer handled on the next turn"),
				fauxAssistantMessage("unexpected extra turn"),
			]);

			// when
			const outcome = await harness.session.prompt(FIRST_PROMPT).then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			await steered;
			await settle(harness);

			// then
			expect(outcome).toBe("resolved");
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		},
	);

	it("#given an accepted compaction #when the first prompt is handled by an input hook without starting a run while a steer joined it #then the joined steer runs, as it does without a compaction", async () => {
		// given
		const promptStarting = Promise.withResolvers<void>();
		const releasePrompt = Promise.withResolvers<void>();
		const harness = await createHarness({
			models: [{ id: "issue-4036-handled", contextWindow: 128_000, maxTokens: 64 }],
			settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "accepted summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
					pi.on("input", async (event) => {
						if (event.text !== FIRST_PROMPT) return { action: "continue" as const };
						promptStarting.resolve();
						await releasePrompt.promise;
						return { action: "handled" as const };
					});
				},
			],
		});
		harnesses.push(harness);
		await seedAndCompact(harness);
		harness.setResponses([
			fauxAssistantMessage("joined steer handled"),
			fauxAssistantMessage("unexpected extra turn"),
		]);

		// when
		const prompt = harness.session.prompt(FIRST_PROMPT);
		await promptStarting.promise;
		await harness.session.prompt(STEER, { streamingBehavior: "steer" });
		releasePrompt.resolve();
		await prompt;
		await settle(harness);

		// then
		expect(steerDeliveries(harness)).toBe(1);
		expect(getAssistantTexts(harness)).toContain("joined steer handled");
		expect(harness.session.getSteeringMessages()).toEqual([]);
	});
});
