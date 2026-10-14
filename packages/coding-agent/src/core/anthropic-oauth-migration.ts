import type { Credential } from "@earendil-works/pi-ai";
import type { CredentialSlot, PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./extensions/builtin/anthropic-subscription/account-management.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
} from "./extensions/builtin/anthropic-subscription/accounts.ts";

type AuthStorageData = Record<string, Credential>;
type Slot = Record<string, unknown>;
type OAuthSlot = Slot & { access: string; refresh: string; expires: number };

export type AnthropicOAuthMigrationResult = {
	data: AuthStorageData;
	migrated: boolean;
	/** Why an `anthropic` OAuth entry was left exactly as stored; set only when nothing was written. */
	skipped?: string;
};

function isPlainObject(value: unknown): value is Slot {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthSlot(value: Slot): value is OAuthSlot {
	return typeof value.access === "string" && typeof value.refresh === "string" && typeof value.expires === "number";
}

function isKeySlot(value: Slot): boolean {
	return typeof value.key === "string" && value.access === undefined && value.refresh === undefined;
}

function importedSlotName(slot: Slot, pooled: boolean, taken: ReadonlySet<string>): string {
	const base =
		pooled && typeof slot.name === "string" && slot.name ? `imported-anthropic-${slot.name}` : "imported-anthropic";
	let name = base.slice(0, 64);
	for (let suffix = 2; taken.has(name); suffix++) name = `${base.slice(0, 58)}-${suffix}`;
	return name;
}

function entrySlots(entry: Slot): { slots: Slot[]; pooled: boolean } | string {
	if (entry.accounts === undefined) return { slots: [entry], pooled: false };
	if (!Array.isArray(entry.accounts) || !entry.accounts.every(isPlainObject)) {
		return "its accounts list is not a list of account objects";
	}
	return { slots: entry.accounts, pooled: true };
}

function remainingApiKeyEntry(keySlots: Slot[], pinned: unknown): PooledCredential | undefined {
	const accounts = keySlots as CredentialSlot[];
	const [first] = accounts;
	if (!first) return undefined;
	const pin = typeof pinned === "string" && accounts.some((slot) => slot.name === pinned) ? { pinned } : {};
	return { type: "api_key", key: first.key, accounts, ...pin };
}

/**
 * One-shot move of a Claude subscription OAuth grant out of the direct `anthropic` provider into the
 * Agent SDK lane (senpi#3259). Anthropic bills a subscription token sent straight to the Messages API
 * as a third-party app (extra usage, not plan limits), so the grant must run through Claude Code.
 *
 * Only OAuth slots move, and each MOVES (omo#7084: one refresh owner). API-key slots stay under
 * `anthropic` exactly as stored, rebuilt as an API-key credential; the entry is deleted only when
 * nothing else is left in it. Pin and display names travel with their slot; existing subscription
 * accounts are never overwritten. Anything the function cannot fully parse is left untouched and
 * reported in `skipped`, so no credential is ever dropped. Completion is derived from the data.
 */
export function migrateAnthropicOAuthToSubscription(data: AuthStorageData): AnthropicOAuthMigrationResult {
	const entry: unknown = data.anthropic;
	if (!isPlainObject(entry) || entry.type !== "oauth") return { data, migrated: false };
	const parsed = entrySlots(entry);
	if (typeof parsed === "string") return { data, migrated: false, skipped: parsed };
	const { slots, pooled } = parsed;
	const oauthSlots = slots.filter(isOAuthSlot);
	const keySlots = pooled ? slots.filter(isKeySlot) : [];
	if (oauthSlots.length === 0) return { data, migrated: false, skipped: "it holds no complete OAuth grant" };
	if (oauthSlots.length + keySlots.length !== slots.length) {
		return { data, migrated: false, skipped: "an account in it is neither a complete OAuth grant nor an API key" };
	}
	const stored = data[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID];
	if (stored !== undefined && !isPlainObject(stored)) {
		return { data, migrated: false, skipped: "the existing anthropic-subscription entry is not an object" };
	}
	const subscription: AnthropicSubscriptionCredential = stored
		? (stored as AnthropicSubscriptionCredential)
		: emptyCredential();
	const accounts: AccountSlot[] = [...(subscription.accounts ?? [])];
	const taken = new Set(accounts.map((slot) => slot.name));
	let pinned = subscription.pinned;
	for (const slot of oauthSlots) {
		const duplicate = accounts.find((account) => account.refresh === slot.refresh);
		const name = duplicate?.name ?? importedSlotName(slot, pooled, taken);
		if (!duplicate) {
			taken.add(name);
			const displayName = typeof slot.displayName === "string" ? { displayName: slot.displayName } : {};
			accounts.push({
				name,
				...displayName,
				access: slot.access,
				refresh: slot.refresh,
				expires: slot.expires,
				source: "import",
			});
		}
		if (pinned === undefined && pooled && slot.name !== undefined && slot.name === entry.pinned) pinned = name;
	}
	const next: AuthStorageData = {
		...data,
		[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]: { ...subscription, accounts, ...(pinned === undefined ? {} : { pinned }) },
	};
	const remaining = remainingApiKeyEntry(keySlots, entry.pinned);
	if (remaining) next.anthropic = remaining;
	else delete next.anthropic;
	return { data: next, migrated: true };
}
