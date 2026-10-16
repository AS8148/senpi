import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { firstUsableCandidate } from "../../src/core/retry-fallback/candidates.ts";
import { isMuchCostlier } from "../../src/core/retry-fallback/controller.ts";
import { resolveRetryFallbackSettings } from "../../src/core/retry-fallback/settings.ts";

function model(provider: string, id: string, input: number): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: { input, output: input * 4, cacheRead: input / 10, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	} as Model<Api>;
}

const flash = model("gw", "deepseek-flash", 0.14);
const pro = model("gw", "deepseek-pro", 1.74);
const sibling = model("gw", "deepseek-flash-b", 0.28);
const subscription = model("sub", "opus", 0);
const registry = {
	find: (provider: string, id: string) =>
		[flash, pro, sibling, subscription].find((m) => m.provider === provider && m.id === id),
	getAll: () => [flash, pro, sibling, subscription],
};

function pick(entries: string[], current: Model<Api>, ratio: number): string | undefined {
	const skipped: string[] = [];
	const candidate = firstUsableCandidate(
		entries,
		{ model: current },
		{
			registry,
			tried: new Set(),
			isSuppressed: () => false,
			isAuthAvailable: () => true,
			isCircuitOpen: () => false,
			isTooCostly: (candidateModel) => isMuchCostlier(candidateModel, current, ratio),
			skip: (raw, reason) => skipped.push(`${raw}:${reason}`),
		},
	);
	return candidate ? `${candidate.model.provider}/${candidate.model.id}` : skipped.join(",");
}

describe("senpi#3467 a fallback never jumps to a much more expensive model without opt-in", () => {
	it("skips a rung that costs more than three times the model it replaces and takes the next affordable one", () => {
		expect(pick(["gw/deepseek-flash", "gw/deepseek-pro", "gw/deepseek-flash-b"], flash, 3)).toBe(
			"gw/deepseek-flash-b",
		);
	});

	it("leaves the chain exhausted rather than paying 12x when no affordable rung remains", () => {
		expect(pick(["gw/deepseek-flash", "gw/deepseek-pro"], flash, 3)).toBe("gw/deepseek-pro:costlier");
	});

	it("allows the pricier rung when the user raises the ratio, and with the guard off", () => {
		expect(pick(["gw/deepseek-flash", "gw/deepseek-pro"], flash, 20)).toBe("gw/deepseek-pro");
		expect(pick(["gw/deepseek-flash", "gw/deepseek-pro"], flash, 0)).toBe("gw/deepseek-pro");
	});

	it("never blocks when either price is unknown or free", () => {
		expect(isMuchCostlier(pro, subscription, 3)).toBe(false);
		expect(isMuchCostlier(subscription, flash, 3)).toBe(false);
	});

	it("defaults the ratio to 3 and reads the user's setting", () => {
		expect(resolveRetryFallbackSettings({}).maxCostRatio).toBe(3);
		expect(resolveRetryFallbackSettings({ fallbackMaxCostRatio: 10 }).maxCostRatio).toBe(10);
		expect(resolveRetryFallbackSettings({ fallbackMaxCostRatio: -1 }).maxCostRatio).toBe(3);
	});
});
