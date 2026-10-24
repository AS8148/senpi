import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, prepareCompaction } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import {
	createRequiredCompactionFallback,
	type DeterministicFallbackDiagnostic,
	formatRequiredCompactionFallbackRejection,
} from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getAssistantTexts } from "./harness.ts";

const WINDOW = 600_000;

function longSession(manager = SessionManager.inMemory()) {
	manager.appendMessage({ role: "user", content: "Investigate the synthetic log", timestamp: 0 });
	for (let step = 0; step < 180; step++) {
		manager.appendMessage({
			...fauxAssistantMessage("", { stopReason: "toolUse", timestamp: step * 2 + 1 }),
			content: [{ type: "toolCall", id: `read-${step}`, name: "read", arguments: { path: "fixture.log" } }],
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: `read-${step}`,
			toolName: "read",
			content: [{ type: "text", text: `step ${step}: ${"synthetic log line\n".repeat(step < 3 ? 150_000 : 240)}` }],
			// Tool envelopes, not just visible text, count toward safe replay.
			...(step === 160 || step === 170 || step === 175
				? { details: { rawOutput: "synthetic payload\n".repeat(150_000) } }
				: {}),
			isError: false,
			timestamp: step * 2 + 2,
		});
	}
	return manager;
}

describe("senpi#4161 budget-only compaction recovery", () => {
	it("searches shorter atomic suffixes when default retention exceeds the budget", () => {
		// Given a long replay-safe transcript whose tool envelopes exceed the window.
		const manager = longSession();
		const branch = manager.getBranch();
		const preparation = prepareCompaction(branch, DEFAULT_COMPACTION_SETTINGS, true);
		if (!preparation) throw new Error("Expected compactable fixture");
		const diagnostics: DeterministicFallbackDiagnostic = {};
		const shorter = prepareCompaction(branch, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1_000 }, true);
		if (!shorter) throw new Error("Expected shorter preparation");
		expect(
			createRequiredCompactionFallback(shorter, WINDOW, "summarization-provider-failure", {}, branch),
		).toBeDefined();

		// When the default 20k retention needs deterministic recovery.
		const result = createRequiredCompactionFallback(
			preparation,
			WINDOW,
			"summarization-provider-failure",
			{},
			branch,
			diagnostics,
		);

		// Then the budget failure leads to a smaller, complete replay, not rejection.
		expect(diagnostics.candidateRejections?.[0]?.rejectionReason).toBe("retained-token-budget-exceeded");
		expect(diagnostics.candidateRejections?.[0]?.estimatedTokens).toBeGreaterThan(576_000);
		expect(result?.details?.retainedSuffix).toBe("later-safe-boundary");
		if (!result) throw new Error("Expected shorter safe suffix");
		expect(result.estimatedTokensAfter).toBeLessThanOrEqual(576_000);
		manager.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore, result.details, true);
		const retained = convertToLlm(manager.buildSessionContext().messages);
		const calls = retained.flatMap((message) =>
			message.role === "assistant"
				? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
				: [],
		);
		expect(calls).toEqual(retained.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
		expect(calls).toContain("read-179");
	});

	it("completes manual fallback and admits a new turn after a terminal summary failure", async () => {
		// Given the same long session and a non-transient provider error, not an invented size failure.
		const harness = await createHarness({
			models: [{ id: "large", contextWindow: WINDOW, maxTokens: 16_000 }],
			extensionFactories: [compactionExtension],
			settings: { compaction: { enabled: true, keepRecentTokens: 20_000, reserveTokens: 24_000 } },
		});
		try {
			harness.setResponses([() => fauxAssistantMessage("ready")]);
			await harness.session.prompt("Initialize the synthetic session");
			longSession(harness.sessionManager);
			harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			harness.setResponses([
				() =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic terminal provider failure" }),
				() => fauxAssistantMessage("continued"),
			]);

			// When manual compaction invokes the real summary and fallback paths.
			const execution = await harness.session.compact().then(
				(result) => ({ result, error: undefined }),
				(error: unknown) => ({ result: undefined, error }),
			);
			const summaryCall = harness.faux.getCallLog()[1];
			expect(summaryCall).toBeDefined();
			if (summaryCall) {
				const toolTextSizes = summaryCall.context.messages.flatMap((message) =>
					message.role === "toolResult"
						? message.content.flatMap((block) => (block.type === "text" ? [block.text.length] : []))
						: [],
				);
				console.info(
					"SUMMARY_INPUT",
					JSON.stringify({
						messages: summaryCall.context.messages.length,
						maxToolTextChars: Math.max(0, ...toolTextSizes),
						totalToolTextChars: toolTextSizes.reduce((total, size) => total + size, 0),
					}),
				);
			}
			if (execution.error) throw execution.error;
			const result = execution.result;
			if (!result) throw new Error("Expected compaction result");

			// Then a checkpoint reconstructs and a real next prompt reaches the faux model.
			expect(result.details).toMatchObject({
				failureKind: "summarization-provider-failure",
				retainedSuffix: "later-safe-boundary",
			});
			await harness.session.prompt("Continue with the retained log");
			expect(getAssistantTexts(harness)).toContain("continued");
			expect(harness.sessionManager.buildSessionContext().messages.length).toBeGreaterThan(0);
		} finally {
			harness.cleanup();
		}
	});

	it("reports dominant rejection counts and first and best candidate sizes", () => {
		// Given a transcript with no fitting suffix, including a non-message oldest entry.
		const manager = SessionManager.inMemory();
		manager.appendModelChange("faux", "large");
		manager.appendMessage({ role: "user", content: "log ".repeat(700_000), timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("reply ".repeat(700_000), { timestamp: 2 }));
		const branch = manager.getBranch();
		const preparation = prepareCompaction(branch, DEFAULT_COMPACTION_SETTINGS, true);
		if (!preparation) throw new Error("Expected compactable fixture");
		const diagnostics: DeterministicFallbackDiagnostic = {};

		// When every candidate is rejected.
		expect(
			createRequiredCompactionFallback(
				preparation,
				WINDOW,
				"summarization-provider-failure",
				{},
				branch,
				diagnostics,
			),
		).toBeUndefined();
		const formatted = formatRequiredCompactionFallbackRejection(diagnostics);
		const diagnostic = JSON.parse(formatted.split("\n")[1] ?? "{}");

		// Then a metadata reconstruction failure cannot hide the dominant budget cause.
		expect(diagnostic.rejectionReason).toBe("retained-token-budget-exceeded");
		expect(diagnostic.rejectionCounts["retained-token-budget-exceeded"]).toBeGreaterThan(1);
		expect(diagnostic.rejectionCounts["context-reconstruction-failed"]).toBe(1);
		expect(diagnostic.firstCandidate.estimatedTokens).toBeGreaterThan(diagnostic.budgetTokens);
		expect(diagnostic.bestCandidate.estimatedTokens).toBeLessThanOrEqual(diagnostic.firstCandidate.estimatedTokens);
	});
});
