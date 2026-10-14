import { type AssistantMessage, fauxAssistantMessage, type ProviderDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { describeProviderFailure, formatProviderFailure } from "../../../src/core/provider-failure.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3228: agent_end carries a structured provider failure with a reason and an action,
// built only from the adapter's providerDiagnostic.

function failedTurn(errorMessage: string, providerDiagnostic?: ProviderDiagnostic): AssistantMessage {
	const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
	return providerDiagnostic === undefined ? message : { ...message, providerDiagnostic };
}

describe("agent_end provider failure", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	async function agentEndOf(response: AssistantMessage): Promise<Extract<AgentSessionEvent, { type: "agent_end" }>> {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		harness.setResponses([response]);
		const ended = new Promise<Extract<AgentSessionEvent, { type: "agent_end" }>>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "agent_end") return;
				unsubscribe();
				resolve(event);
			});
		});
		await harness.session.prompt("go");
		return ended;
	}

	it.each([
		[{ category: "auth", httpStatus: 401, evidence: "structured_status" }, "auth", /re-authenticate/],
		[
			{ category: "rate_limit", httpStatus: 429, code: "rate_limit_error", evidence: "structured_code" },
			"rate_limit",
			/retry later/,
		],
		[
			{ category: "quota", httpStatus: 429, code: "insufficient_quota", evidence: "structured_code" },
			"quota",
			/plan or credits/,
		],
		[
			{ category: "context_limit", code: "context_length_exceeded", evidence: "structured_code" },
			"context_limit",
			/compact/,
		],
		[{ category: "network", code: "ECONNRESET", evidence: "structured_transport" }, "network", /connectivity/],
	] as const)("classifies %o as %s with its action", async (diagnostic, category, action) => {
		const end = await agentEndOf(failedTurn("provider failed", diagnostic));
		expect(end.failure).toMatchObject({ category, provider: "faux" });
		expect(end.failure?.action).toMatch(action);
		expect(end.failure?.reason.length).toBeGreaterThan(0);
	});

	it("reports an unclassified provider error as unknown with the provider and code, never from the message", async () => {
		const end = await agentEndOf(
			failedTurn("401 invalid api key: rate limit quota exceeded", {
				category: "unknown",
				httpStatus: 403,
				code: "permission_error",
				evidence: "structured_code",
			}),
		);
		expect(end.failure?.category).toBe("unknown");
		expect(end.failure?.reason).toMatch(/could not classify \(faux, code permission_error\)/);
		expect(end.failure?.action).toMatch(/^retry once/);
	});

	it("falls back to unknown, not a guess from the message, when the error carries no diagnostic", async () => {
		const end = await agentEndOf(failedTurn("429 rate limit exceeded"));
		expect(end.failure?.category).toBe("unknown");
		expect(end.failure?.reason).toMatch(/\(faux, no code\)/);
	});

	it("omits failure on a successful turn", async () => {
		const end = await agentEndOf(fauxAssistantMessage("fine"));
		expect(end.failure).toBeUndefined();
	});

	it("omits failure on an aborted turn", async () => {
		const end = await agentEndOf(fauxAssistantMessage("", { stopReason: "aborted" }));
		expect(end.failure).toBeUndefined();
	});

	it("renders one line with the reason and the action", () => {
		expect(
			formatProviderFailure(
				describeProviderFailure(
					{ category: "rate_limit", httpStatus: 429, code: "rate_limit_error", evidence: "structured_code" },
					"anthropic",
				),
			),
		).toMatch(/^The provider is rate limiting requests\. Action: retry later/);
		expect(formatProviderFailure(describeProviderFailure(undefined, "openai"))).toMatch(
			/could not classify .*Action: retry once/,
		);
	});
});
