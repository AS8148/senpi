import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	buildAnthropicSubscriptionQueryOptions,
	requestedContextWindow,
} from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";

function model(id: string, contextWindow: number): Model<Api> {
	return {
		id,
		name: id,
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		baseUrl: "claude-sdk-oauth",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 128_000,
	};
}

function optionsFor(target: Model<Api>) {
	return buildAnthropicSubscriptionQueryOptions({
		model: target,
		context: { messages: [] },
		cwd: process.cwd(),
		providerSettings: {},
	});
}

describe("#3408: the window senpi plans against is the window the subscription request gets", () => {
	it("requests the 1M window for a model whose catalog window is 1M", () => {
		const opus = model("claude-opus-5-5", 1_000_000);

		const options = optionsFor(opus);

		expect(options.betas).toEqual(["context-1m-2025-08-07"]);
		expect(requestedContextWindow(options)).toBe(opus.contextWindow);
	});

	it("requests no long-context window for a 200k model, and plans for 200k", () => {
		const haiku = model("claude-haiku-4-5", 200_000);

		const options = optionsFor(haiku);

		expect(options.betas).toBeUndefined();
		expect(requestedContextWindow(options)).toBe(haiku.contextWindow);
	});

	it("classifies a refused long-context window on its own, never as a rate limit that blocks the account", () => {
		const refusal = new Error(
			"Extra usage is required for long context · enable extra usage at claude.ai/settings/usage, or use --model to switch to standard context (rate_limit)",
		);

		expect(classifySdkError(refusal)).toEqual({ kind: "long_context_unavailable", retryable: true });
	});
});
