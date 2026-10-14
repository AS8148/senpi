import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { migrateAnthropicOAuthToSubscription } from "../../../src/core/auth-provider-key-migration.ts";
import type { AnthropicSubscriptionCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { findInitialModel, restoreModelFromSession } from "../../../src/core/model-resolver.ts";
import { usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/3259: a Claude subscription logged in
// through the direct `anthropic` provider is billed by Anthropic as a third-party app (extra usage),
// and the fallback chain replayed the same rejection on every Anthropic model. The subscription must
// run through the Agent SDK lane (`anthropic-subscription`) and the rejection must end the turn once.

const THIRD_PARTY_400 =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}';

type Store = Record<string, Credential>;

function subscriptionOf(data: Store): AnthropicSubscriptionCredential | undefined {
	return data["anthropic-subscription"] as AnthropicSubscriptionCredential | undefined;
}

describe("subscription OAuth grant moves to the Agent SDK lane (#3259)", () => {
	it("moves a flat anthropic OAuth grant into anthropic-subscription accounts", () => {
		const result = migrateAnthropicOAuthToSubscription({
			anthropic: { type: "oauth", access: "acc-1", refresh: "ref-1", expires: 42 },
		});
		expect(result.migrated).toBe(true);
		expect(result.data.anthropic).toBeUndefined();
		expect(subscriptionOf(result.data)?.accounts).toEqual([
			{ name: "imported-anthropic", access: "acc-1", refresh: "ref-1", expires: 42, source: "import" },
		]);
	});

	it("moves every pooled slot next to existing subscription accounts without overwriting them", () => {
		const result = migrateAnthropicOAuthToSubscription({
			anthropic: {
				type: "oauth",
				access: "acc-1",
				refresh: "ref-1",
				expires: 1,
				accounts: [
					{ name: "default", access: "acc-1", refresh: "ref-1", expires: 1 },
					{ name: "work", access: "acc-2", refresh: "ref-2", expires: 2 },
				],
			} as Credential,
			"anthropic-subscription": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4102444800000,
				accounts: [{ name: "imported-anthropic", access: "keep", refresh: "keep", expires: 9, source: "login" }],
			} as Credential,
		});
		expect(result.migrated).toBe(true);
		expect(result.data.anthropic).toBeUndefined();
		expect(subscriptionOf(result.data)?.accounts?.map((slot) => [slot.name, slot.refresh])).toEqual([
			["imported-anthropic", "keep"],
			["imported-anthropic-default", "ref-1"],
			["imported-anthropic-work", "ref-2"],
		]);
	});

	it("leaves an Anthropic API key and an already-migrated store untouched", () => {
		const apiKey: Store = { anthropic: { type: "api_key", key: "sk-ant-api03-x" } };
		expect(migrateAnthropicOAuthToSubscription(apiKey)).toEqual({ data: apiKey, migrated: false });
		const done: Store = { other: { type: "api_key", key: "k" } };
		expect(migrateAnthropicOAuthToSubscription(done)).toEqual({ data: done, migrated: false });
	});
});

function subscriptionModel(id: string): Model<Api> {
	const base = getModels("anthropic").find((model) => model.id === id);
	if (!base) throw new Error(`missing anthropic model ${id}`);
	return { ...base, provider: "anthropic-subscription" } as Model<Api>;
}

function runtimeWithAuthOn(provider: string): Parameters<typeof findInitialModel>[0]["modelRuntime"] {
	const models: Model<Api>[] = [...(getModels("anthropic") as Model<Api>[]), subscriptionModel("claude-opus-5-5")];
	return {
		getAvailableSnapshot: () => models.filter((model) => model.provider === provider),
		getModel: (p: string, id: string) => models.find((model) => model.provider === p && model.id === id),
		hasConfiguredAuth: (p: string) => p === provider,
	} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
}

describe("saved anthropic selections follow the moved subscription (#3259)", () => {
	it("starts a saved anthropic default on the same model in the subscription lane", async () => {
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: "claude-opus-5-5",
			modelRuntime: runtimeWithAuthOn("anthropic-subscription"),
		});
		expect(initial.model).toMatchObject({ provider: "anthropic-subscription", id: "claude-opus-5-5" });
		expect(initial.provenance).toBe("settings");
	});

	it("restores an anthropic session onto the subscription lane without a fallback warning", async () => {
		const restored = await restoreModelFromSession(
			"anthropic",
			"claude-opus-5-5",
			undefined,
			false,
			runtimeWithAuthOn("anthropic-subscription"),
		);
		expect(restored.model).toMatchObject({ provider: "anthropic-subscription", id: "claude-opus-5-5" });
		expect(restored.fallbackMessage).toBeUndefined();
	});

	it("keeps the direct anthropic provider when it still holds its own auth", async () => {
		const restored = await restoreModelFromSession(
			"anthropic",
			"claude-opus-5-5",
			undefined,
			false,
			runtimeWithAuthOn("anthropic"),
		);
		expect(restored.model).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
	});
});

describe("third-party billing rejection ends the Anthropic account, not one model (#3259)", () => {
	it("scopes the rejection to the whole account so the chain skips sibling Anthropic models", () => {
		expect(usageLimitScope(THIRD_PARTY_400)).toBe("account");
	});
});
