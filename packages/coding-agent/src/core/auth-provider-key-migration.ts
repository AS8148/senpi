import type { Credential } from "@earendil-works/pi-ai";
import { LEGACY_PROVIDER_IDS } from "@earendil-works/pi-ai";
import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "./extensions/builtin/anthropic-subscription/account-management.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
} from "./extensions/builtin/anthropic-subscription/accounts.ts";

type AuthStorageData = Record<string, Credential>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One-shot auth.json provider-key migration for the provider rename (#1989):
 * a credential stored under a legacy provider id (`openai-codex`,
 * `claude-sdk-oauth`) is rewritten under its canonical id
 * (`chatgpt-subscription`, `anthropic-subscription`).
 *
 * Completion is derived from the data, not a migrations-state marker: once the
 * legacy key is absent the function is a no-op, so a busy credential store can
 * skip a load and retry later, and an older binary re-introducing a legacy key
 * after the fact still gets migrated. The credential object moves VERBATIM —
 * pools (`accounts`, `login-N` names, `pinned`, `slotState`) and the
 * managed-sentinel values inside the flat fields are preserved under the new
 * key, byte for byte.
 *
 * Conflict rule: when both keys hold an entry, the canonical entry wins and
 * the legacy entry is removed from the live file only — the timestamped backup
 * taken before the rewrite still holds it. Entries are never merged: one
 * single-use OAuth grant must not end up with two refresh owners.
 */
export function migrateLegacyProviderKeys(data: AuthStorageData): { data: AuthStorageData; migrated: boolean } {
	let next: AuthStorageData | undefined;
	for (const [legacyId, canonicalId] of Object.entries(LEGACY_PROVIDER_IDS)) {
		const legacy = data[legacyId];
		// Only plain-object entries move; anything else found on the key stays
		// put for a human to inspect rather than being renamed blind.
		if (!isPlainObject(legacy)) continue;
		next ??= { ...data };
		delete next[legacyId];
		if (next[canonicalId] === undefined) {
			next[canonicalId] = legacy as Credential;
		}
	}
	return next ? { data: next, migrated: true } : { data, migrated: false };
}

type OAuthGrant = { name?: string; access: string; refresh: string; expires: number };

function isOAuthGrant(value: unknown): value is OAuthGrant {
	return (
		isPlainObject(value) &&
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number"
	);
}

/** Every grant a stored `anthropic` OAuth entry holds: its pool slots, else its flat fields. */
function anthropicGrants(entry: Record<string, unknown>): { grants: OAuthGrant[]; pooled: boolean } {
	const slots = Array.isArray(entry.accounts) ? entry.accounts.filter(isOAuthGrant) : [];
	if (slots.length > 0) return { grants: slots, pooled: true };
	const flat = isOAuthGrant(entry) ? [{ access: entry.access, refresh: entry.refresh, expires: entry.expires }] : [];
	return { grants: flat, pooled: false };
}

function importedSlotName(grant: OAuthGrant, pooled: boolean, taken: ReadonlySet<string>): string {
	const base = pooled && grant.name ? `imported-anthropic-${grant.name}` : "imported-anthropic";
	let name = base.slice(0, 64);
	for (let suffix = 2; taken.has(name); suffix++) name = `${base.slice(0, 58)}-${suffix}`;
	return name;
}

/**
 * One-shot move of a Claude subscription OAuth grant out of the direct `anthropic` provider into the
 * Agent SDK lane (senpi#3259). Anthropic bills a subscription token sent straight to the Messages API
 * as a third-party app (extra usage, not plan limits), so the grant must run through Claude Code.
 *
 * Like {@link migrateLegacyProviderKeys}, completion is derived from the data: once `anthropic` holds
 * no OAuth entry this is a no-op. The grant MOVES (omo#7084): a single-use refresh token must never
 * have two refresh owners. Every pool slot becomes its own subscription account; existing
 * subscription accounts are never overwritten. An Anthropic API key is left where it is.
 */
export function migrateAnthropicOAuthToSubscription(data: AuthStorageData): {
	data: AuthStorageData;
	migrated: boolean;
} {
	const entry: unknown = data.anthropic;
	if (!isPlainObject(entry) || entry.type !== "oauth") return { data, migrated: false };
	const { grants, pooled } = anthropicGrants(entry);
	const stored = data[ANTHROPIC_SUBSCRIPTION_PROVIDER_ID];
	const subscription: AnthropicSubscriptionCredential = isPlainObject(stored)
		? (stored as AnthropicSubscriptionCredential)
		: emptyCredential();
	const accounts: AccountSlot[] = [...(subscription.accounts ?? [])];
	const taken = new Set(accounts.map((slot) => slot.name));
	for (const grant of grants) {
		if (accounts.some((slot) => slot.refresh === grant.refresh)) continue;
		const name = importedSlotName(grant, pooled, taken);
		taken.add(name);
		accounts.push({ name, access: grant.access, refresh: grant.refresh, expires: grant.expires, source: "import" });
	}
	const next: AuthStorageData = { ...data, [ANTHROPIC_SUBSCRIPTION_PROVIDER_ID]: { ...subscription, accounts } };
	delete next.anthropic;
	return { data: next, migrated: true };
}
