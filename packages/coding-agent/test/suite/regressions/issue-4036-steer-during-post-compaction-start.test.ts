import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const FIRST_PROMPT = "first prompt after the compaction";
const STEER = "steer sent while the first prompt after the compaction was starting";

async function createAcceptedCompactionHarness(
	thresholdCompactionEnabled: boolean,
	onPromptStarting: (prompt: string) => Promise<void>,
) {
	return createHarness({
		models: [{ id: "issue-4036", contextWindow: 128_000, maxTokens: 64 }],
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

async function compactOnThreshold(harness: Harness): Promise<void> {
	const runAutoCompaction = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof runAutoCompaction !== "function") throw new Error("Expected AgentSession._runAutoCompaction");
	await runAutoCompaction.call(harness.session, "threshold", false);
}

describe("#4036 a steer sent while the first prompt after a compaction is starting", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		{ thresholdCompaction: "disabled", enabled: false },
		{ thresholdCompaction: "enabled", enabled: true },
	])(
		"#given an accepted compaction with threshold compaction $thresholdCompaction #when a steer arrives while the next ordinary prompt starts #then it is delivered in that run, exactly once, not parked until a later compaction",
		async ({ enabled }) => {
			// given
			const promptStarting = Promise.withResolvers<void>();
			const releasePrompt = Promise.withResolvers<void>();
			const harness = await createAcceptedCompactionHarness(enabled, async (prompt) => {
				if (prompt !== FIRST_PROMPT) return;
				promptStarting.resolve();
				await releasePrompt.promise;
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("seed response")]);
			await harness.session.prompt("seed context ".repeat(40));
			await compactOnThreshold(harness);
			expect(harness.eventsOfType("compaction_end")).toEqual([expect.objectContaining({ accepted: true })]);
			harness.setResponses([
				fauxAssistantMessage("ordinary response after the compaction"),
				fauxAssistantMessage("steer handled"),
				fauxAssistantMessage("later turn handled"),
				fauxAssistantMessage("unexpected extra turn"),
			]);

			// when
			const prompt = harness.session.prompt(FIRST_PROMPT);
			await promptStarting.promise;
			await harness.session.prompt(STEER, { streamingBehavior: "steer" });
			releasePrompt.resolve();
			await prompt;
			await harness.session.waitForSettledSessionWork();
			const deliveredBeforeLaterTurns = getUserTexts(harness).filter((text) => text === STEER).length;
			await harness.session.prompt("a later ordinary turn");
			await harness.session.waitForSettledSessionWork();

			// then
			expect(deliveredBeforeLaterTurns).toBe(1);
			expect(getUserTexts(harness).filter((text) => text === STEER)).toHaveLength(1);
			expect(getAssistantTexts(harness)).toContain("steer handled");
			expect(harness.session.getSteeringMessages()).toEqual([]);
			expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		},
	);
});
