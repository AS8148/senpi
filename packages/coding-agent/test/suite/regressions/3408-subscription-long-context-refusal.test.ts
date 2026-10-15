import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { runFailover } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import {
	anthropicSubscriptionModels,
	registerAnthropicSubscriptionExtension,
} from "../../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import {
	_resetLongContextForTesting,
	longContextAvailable,
	markLongContextRefused,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import {
	buildAnthropicSubscriptionQueryOptions,
	requestedContextWindow,
} from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/types.ts";

const REFUSAL = "Extra usage is required for long context · enable extra usage at claude.ai/settings/usage (rate_limit)";
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "senpi-3408-"));
	_resetLongContextForTesting(join(directory, "long-context.json"));
});

afterEach(() => {
	_resetLongContextForTesting();
	rmSync(directory, { recursive: true, force: true });
});

function opus(): Model<Api> {
	const catalog = anthropicSubscriptionModels(true).find((model) => model.id === "claude-opus-5-5");
	if (!catalog) throw new Error("claude-opus-5-5 is missing from the catalog");
	return { ...catalog, api: "claude-sdk-oauth", provider: "anthropic-subscription", baseUrl: "claude-sdk-oauth" } as Model<Api>;
}

describe("#3408: an account that refuses the 1M window plans and requests 200k", () => {
	it("plans against 200k after a refusal, and the request no longer asks for 1M", () => {
		markLongContextRefused();

		const planned = anthropicSubscriptionModels().find((model) => model.id === "claude-opus-5-5");
		const options = buildAnthropicSubscriptionQueryOptions({
			model: { ...opus(), contextWindow: 1_000_000 },
			context: { messages: [] },
			cwd: directory,
			providerSettings: {},
		});

		expect(planned?.contextWindow).toBe(200_000);
		expect(options.betas).toBeUndefined();
		expect(requestedContextWindow(options)).toBe(planned?.contextWindow);
	});

	it("re-registers the lane's models at 200k the moment the refusal is recorded", () => {
		const registrations: Array<{ models?: Array<{ id: string; contextWindow: number }> }> = [];
		const pi = new Proxy({} as ExtensionAPI, {
			get: (_target, key) =>
				key === "registerProvider"
					? (_id: string, config: { models?: Array<{ id: string; contextWindow: number }> }) => registrations.push(config)
					: () => undefined,
		});
		registerAnthropicSubscriptionExtension(pi);
		const initial = registrations[0]?.models?.find((model) => model.id === "claude-opus-5-5");

		markLongContextRefused();

		const after = registrations.at(-1)?.models?.find((model) => model.id === "claude-opus-5-5");
		expect(initial?.contextWindow).toBe(1_000_000);
		expect(after?.contextWindow).toBe(200_000);
	});

	it("retries once on the same account without blocking it, after recording the refusal", async () => {
		const account: AccountSlot = { name: "main" } as AccountSlot;
		const tried: string[] = [];
		const store = {} as Parameters<typeof runFailover>[0]["store"];

		const events: string[] = [];
		for await (const event of runFailover<string>({
			accounts: [account],
			selectFn: (accounts) => accounts[0] as AccountSlot,
			runAttempt: async function* (slot) {
				tried.push(`${slot.name}:${longContextAvailable() ? "1m" : "200k"}`);
				if (tried.length === 1) throw new Error(REFUSAL);
				yield "answer";
			},
			classify: classifySdkError,
			store,
			providerId: "anthropic-subscription",
			onLongContextRefused: () => markLongContextRefused(),
		})) {
			events.push(event);
		}

		expect(tried).toEqual(["main:1m", "main:200k"]);
		expect(events).toEqual(["answer"]);
	});
});
