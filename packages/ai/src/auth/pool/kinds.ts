import type { Credential } from "../types.ts";
import { type CredentialSlot, listSlots, type PooledCredential } from "./slots.ts";

export type CredentialKind = Credential["type"];

/** OAuth material (access/refresh) makes a slot an OAuth login; a slot carrying only a key is an API key. */
export function slotKind(slot: Pick<CredentialSlot, "access" | "refresh">): CredentialKind {
	return slot.access !== undefined || slot.refresh !== undefined ? "oauth" : "api_key";
}

/** The kinds of login a stored credential actually holds, read from its slots (senpi#3448). */
export function credentialKinds(credential: PooledCredential | undefined): ReadonlySet<CredentialKind> {
	return new Set(listSlots(credential).map(slotKind));
}

function flatFromSlot(slot: CredentialSlot): Credential {
	const env = slot.env === undefined ? {} : { env: slot.env };
	if (slotKind(slot) === "oauth") {
		return {
			type: "oauth",
			access: slot.access ?? "",
			refresh: slot.refresh ?? "",
			expires: slot.expires ?? 0,
			...env,
		};
	}
	return { type: "api_key", key: slot.key, ...env };
}

export type MixedKindRepair = { credential: PooledCredential; replaced: CredentialKind };

/**
 * A pool holds one kind of credential; slots are projected through the top-level type, so a slot of
 * the other kind can never be used. Builds before senpi#3448 appended a login of the other kind as
 * such a slot. The last slot is the most recent login, so its kind wins: the credential keeps only
 * that kind's slots (and a pin that still names one), and its flat fields come from the last slot
 * when the top-level type changes. Returns undefined for a credential that is already one kind.
 */
export function repairMixedKindPool(credential: PooledCredential): MixedKindRepair | undefined {
	const accounts = credential.accounts;
	if (!Array.isArray(accounts)) return undefined;
	const last = accounts.at(-1);
	if (!last) return undefined;
	const winner = slotKind(last);
	const kept = accounts.filter((slot) => slotKind(slot) === winner);
	if (winner === credential.type && kept.length === accounts.length) return undefined;
	const replaced: CredentialKind =
		winner === credential.type ? (winner === "oauth" ? "api_key" : "oauth") : credential.type;
	const pinned = kept.some((slot) => slot.name === credential.pinned) ? { pinned: credential.pinned } : {};
	if (winner === credential.type) {
		const { pinned: _dropped, ...rest } = credential;
		return { credential: { ...rest, accounts: kept, ...pinned }, replaced };
	}
	const flat = flatFromSlot(last);
	return { credential: kept.length > 1 ? { ...flat, accounts: kept, ...pinned } : flat, replaced };
}
