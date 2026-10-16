import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { unblockProviderAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/account-management.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	DEFAULT_RATE_LIMIT_BLOCK_MS,
	MAX_RATE_LIMIT_BLOCK_MS,
	runFailover,
} from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";

const PROVIDER = "anthropic-subscription";
const T0 = Date.UTC(2026, 9, 16, 10, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function pool(tag: string): AccountSlot[] {
	return [
		{ name: `a-${tag}`, refresh: "r-a", access: "x-a", expires: 1, source: "login" },
		{ name: `b-${tag}`, refresh: "r-b", access: "x-b", expires: 1, source: "login" },
	];
}

function credentialOf(accounts: AccountSlot[]): AnthropicSubscriptionCredential {
	return accounts.reduce<AnthropicSubscriptionCredential>(
		(credential, account) => addAccount(credential, account),
		emptyCredential(),
	);
}

async function storeWith(accounts: AccountSlot[]): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () => credentialOf(accounts));
	return store;
}

async function slotOf(store: CredentialStore, name: string): Promise<AccountSlot | undefined> {
	return ((await store.read(PROVIDER)) as AnthropicSubscriptionCredential).accounts?.find(
		(account) => account.name === name,
	);
}

async function failFirst(store: CredentialStore, accounts: AccountSlot[], failure: string): Promise<void> {
	const [first] = accounts as [AccountSlot];
	const stream = runFailover<{ type: "done" }>({
		accounts,
		selectFn: (slots) => slots.find((slot) => slot.blockedUntil === undefined) ?? slots[0]!,
		runAttempt: async function* (slot) {
			if (slot.name === first.name) throw new Error(failure);
			yield { type: "done" };
		},
		classify: classifySdkError,
		store,
		providerId: PROVIDER,
		now: () => T0,
		sleep: async () => {},
	});
	for await (const _event of stream) {
		// drained
	}
}

async function blockFor(failure: string, tag: string): Promise<number> {
	const accounts = pool(tag);
	const store = await storeWith(accounts);
	await failFirst(store, accounts, failure).catch(() => undefined);
	return ((await slotOf(store, accounts[0]!.name))?.blockedUntil ?? T0) - T0;
}

describe("senpi#3462 a long usage-limit block never outlives the limit and always has a way out", () => {
	it.each([
		["a 5-hour limit", "You've hit your 5-hour limit \u00b7 resets Oct 30, 9am", 5 * HOUR],
		["a session limit", "You've hit your session limit \u00b7 resets Oct 30, 9am", 5 * HOUR],
		[
			"a weekly limit, under the 48 h block ceiling",
			"You've hit your weekly limit \u00b7 resets Dec 30, 9am",
			MAX_RATE_LIMIT_BLOCK_MS,
		],
		["a daily limit", "You've hit your daily limit \u00b7 resets Dec 30, 9am", DAY],
		["a limit with no window word", "You've reached your usage limit. Try again Dec 30, 9am", 5 * HOUR],
	])("caps a misread reset on %s at the limit's own window", async (_label, failure, capMs) => {
		expect(await blockFor(failure, `cap-${capMs}-${_label.length}`)).toBe(capMs);
	});

	it.each([
		["ordinary prose", "You hit your stride today; the limit is fine, resets in 3 hours"],
		["a rate limit on an endpoint", "You've reached your rate limit for this endpoint, resets in 3 hours"],
		["a usage-limit text under another status", "HTTP 400: You've hit your session limit \u00b7 resets in 3 hours"],
		["the shape inside other text", "tool output: You've hit your session limit \u00b7 resets in 3 hours"],
	])("takes no long block from %s", async (_label, failure) => {
		expect(await blockFor(failure, `near-${_label.length}`)).toBeLessThanOrEqual(DEFAULT_RATE_LIMIT_BLOCK_MS);
	});

	it("clears a stored limit block when the account then serves a turn", async () => {
		// given another request stored a long block on the account after this turn read the pool
		const accounts = pool("served");
		const store = await storeWith(accounts);
		await store.modify(PROVIDER, async (current) => ({
			...(current as AnthropicSubscriptionCredential),
			accounts: ((current as AnthropicSubscriptionCredential).accounts ?? []).map((account) =>
				account.name === accounts[0]!.name
					? { ...account, blockedUntil: T0 + 5 * HOUR, blockReason: "rate_limit" }
					: account,
			),
		}));

		// when a turn is served by that account
		const stream = runFailover<{ type: "done" }>({
			accounts,
			selectFn: (slots) => slots[0]!,
			runAttempt: async function* () {
				yield { type: "done" };
			},
			classify: classifySdkError,
			store,
			providerId: PROVIDER,
			now: () => T0,
		});
		for await (const _event of stream) {
			// drained
		}

		// then the block is gone
		expect((await slotOf(store, accounts[0]!.name))?.blockedUntil).toBeUndefined();
	});

	it("lifts a usage block on '/claude-account unblock' but keeps an auth block", async () => {
		const storage = AuthStorage.inMemory();
		const [limited, rejected] = pool("manual") as [AccountSlot, AccountSlot];
		await storage.modify(PROVIDER, async () =>
			credentialOf([
				{ ...limited, blockedUntil: T0 + 5 * HOUR, blockReason: "rate_limit" },
				{ ...rejected, blockedUntil: T0 + 5 * HOUR, blockReason: "auth_error" },
			]),
		);

		expect(await unblockProviderAccount(storage, PROVIDER, limited.name, {})).toBe(true);
		expect(await unblockProviderAccount(storage, PROVIDER, rejected.name, {})).toBe(false);

		const accounts = (storage.get(PROVIDER) as AnthropicSubscriptionCredential).accounts ?? [];
		expect(accounts.find((account) => account.name === limited.name)?.blockedUntil).toBeUndefined();
		expect(accounts.find((account) => account.name === rejected.name)?.blockReason).toBe("auth_error");
	});
});
