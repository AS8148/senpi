import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	DEFAULT_RATE_LIMIT_BLOCK_MS,
	runFailover,
} from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import { subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";

const PROVIDER = "anthropic-subscription";
const T0 = Date.UTC(2026, 9, 16, 10, 0, 0);
const HOUR = 3_600_000;
const pool: AccountSlot[] = [
	{ name: "primary-3462", refresh: "r-1", access: "a-1", expires: 1, source: "login" },
	{ name: "secondary-3462", refresh: "r-2", access: "a-2", expires: 1, source: "login" },
];
const [primary, secondary] = pool.map((account) => account.name) as [string, string];

async function storeWithPool(): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () =>
		pool.reduce<AnthropicSubscriptionCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	return store;
}

async function storedPool(store: CredentialStore): Promise<AccountSlot[]> {
	return ((await store.read(PROVIDER)) as AnthropicSubscriptionCredential).accounts ?? [];
}

async function runTurn(
	store: CredentialStore,
	now: number,
	failure: string,
	preferred?: string,
): Promise<{ attempts: string[]; served: string }> {
	const attempts: string[] = [];
	let served = "";
	const stream = runFailover<{ type: "done" }>({
		accounts: await storedPool(store),
		selectFn: (accounts) =>
			selectAccount(accounts, {
				sessionId: "senpi-3462",
				pinnedAccount: primary,
				...(preferred === undefined ? {} : { preferredAccount: preferred }),
				now,
			}),
		runAttempt: async function* (slot) {
			attempts.push(slot.name);
			if (slot.name === primary) throw new Error(failure);
			served = slot.name;
			yield { type: "done" };
		},
		classify: classifySdkError,
		store,
		providerId: PROVIDER,
		now: () => now,
		sleep: async () => {},
	});
	for await (const _event of stream) {
		// drained
	}
	return { attempts, served };
}

async function blockedFor(store: CredentialStore, name: string, now: number): Promise<number> {
	const slot = (await storedPool(store)).find((account) => account.name === name);
	return (slot?.blockedUntil ?? now) - now;
}

afterEach(() => {
	// The limit store is process-wide; nothing here records into it except the window case, which uses its own account names.
});

describe("senpi#3462 an account usage limit blocks the account until its reset", () => {
	it("blocks a spent pinned account for the reset its message names, so later turns never retry it", async () => {
		// given a pinned primary whose 5-hour limit resets in one hour, and a healthy secondary
		const store = await storeWithPool();
		const limit = "You've hit your 5-hour limit \u00b7 resets in 1 hour";

		// when 20 turns run 30 s apart (the reporter's ten minutes)
		const turns: string[][] = [];
		let served: string | undefined;
		for (let turn = 0; turn < 20; turn++) {
			const result = await runTurn(store, T0 + turn * 30_000, limit, served);
			served = result.served;
			turns.push(result.attempts);
		}

		// then only the first turn tries the spent account, and its block lasts the hour
		expect(turns[0]).toEqual([primary, secondary]);
		expect(turns.slice(1).filter((attempts) => attempts.includes(primary))).toEqual([]);
		expect(await blockedFor(store, primary, T0)).toBe(HOUR);
	});

	it("keeps the short default block for a limit that names no reset", async () => {
		const store = await storeWithPool();
		await runTurn(store, T0, "You've hit your usage limit");
		expect(await blockedFor(store, primary, T0)).toBe(DEFAULT_RATE_LIMIT_BLOCK_MS);
	});

	it("keeps a plain rate limit on the short default block", async () => {
		const store = await storeWithPool();
		await runTurn(store, T0, "HTTP 429 too many requests");
		expect(await blockedFor(store, primary, T0)).toBe(DEFAULT_RATE_LIMIT_BLOCK_MS);
	});

	it("falls back to the reset the account's spent limit window reported when the message names none", async () => {
		// given the SDK reported the primary's 5-hour window as fully used, resetting in two hours
		const store = await storeWithPool();
		subscriptionLimits.record(
			PROVIDER,
			primary,
			[
				{
					id: "claude:5h",
					label: "5h",
					windowMinutes: 300,
					usedPercent: 100,
					resetsAt: new Date(T0 + 2 * HOUR).toISOString(),
				},
			],
			new Date(T0),
		);

		// when the primary then fails with a reset-less limit
		await runTurn(store, T0, "You've hit your usage limit");

		// then the block lasts until that window resets
		expect(await blockedFor(store, primary, T0)).toBe(2 * HOUR);
	});
});
