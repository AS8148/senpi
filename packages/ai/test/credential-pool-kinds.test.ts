import { describe, expect, test } from "vitest";
import { credentialKinds, repairMixedKindPool } from "../src/auth/pool/kinds.ts";
import { appendLoginSlot, type Credential, listSlots, type PooledCredential } from "../src/auth/pool/slots.ts";

const oauth: Credential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 };
const apiKey: Credential = { type: "api_key", key: "new-key" };

// senpi#3448 / omo-desktop-app#2793: a pool holds one kind of credential. A login of the
// other kind used to be appended as a slot the pool could never project, so the saved key was
// never used and the API-key row stayed unconfigured.
describe("a login of another kind replaces the credential (senpi#3448)", () => {
	test("an API key saved over an OAuth login becomes the credential", () => {
		const next = appendLoginSlot(oauth, apiKey);
		expect(next).toEqual(apiKey);
		expect(credentialKinds(next)).toEqual(new Set(["api_key"]));
	});

	test("an OAuth login over an API key becomes the credential", () => {
		const next = appendLoginSlot(apiKey, oauth);
		expect(next).toEqual(oauth);
		expect(credentialKinds(next)).toEqual(new Set(["oauth"]));
	});

	test("an API key over an OAuth pool replaces the whole pool", () => {
		const pool: PooledCredential = {
			...oauth,
			accounts: [
				{ name: "default", source: "login", access: "a1", refresh: "r1", expires: 1 },
				{ name: "work", source: "login", access: "a2", refresh: "r2", expires: 2 },
			],
			pinned: "work",
		};
		expect(appendLoginSlot(pool, apiKey)).toEqual(apiKey);
	});

	test("a login of the same kind still joins the pool", () => {
		const next = appendLoginSlot({ type: "api_key", key: "first" }, { type: "api_key", key: "second" });
		expect(listSlots(next).map((slot) => slot.key)).toEqual(["first", "second"]);
	});
});

describe("a mixed pool already on disk is repaired to its most recent login (senpi#3448)", () => {
	const mixed: PooledCredential = {
		...oauth,
		accounts: [
			{ name: "default", source: "login", access: "old-access", refresh: "old-refresh", expires: 1 },
			{ name: "login-2", source: "login", key: "new-key" },
		],
	};

	test("reports the kinds a stored credential actually holds", () => {
		expect(credentialKinds(mixed)).toEqual(new Set(["oauth", "api_key"]));
		expect(credentialKinds(undefined)).toEqual(new Set());
	});

	test("the last slot's kind wins and becomes the credential", () => {
		const repaired = repairMixedKindPool(mixed);
		expect(repaired).toEqual({ credential: { type: "api_key", key: "new-key" }, replaced: "oauth" });
	});

	test("a malformed accounts value is left for the store's own repair", () => {
		const malformed = { ...oauth, accounts: { bad: true } } as unknown as PooledCredential;
		expect(repairMixedKindPool(malformed)).toBeUndefined();
	});

	test("a pin on a dropped slot is cleared when the stored kind wins", () => {
		const pool: PooledCredential = {
			type: "api_key",
			key: "k1",
			accounts: [
				{ name: "default", key: "k1" },
				{ name: "personal", access: "a1", refresh: "r1", expires: 5 },
				{ name: "work", key: "k2" },
			],
			pinned: "personal",
		};
		expect(repairMixedKindPool(pool)).toEqual({
			credential: {
				type: "api_key",
				key: "k1",
				accounts: [
					{ name: "default", key: "k1" },
					{ name: "work", key: "k2" },
				],
			},
			replaced: "oauth",
		});
	});

	test("a single-kind pool is left alone", () => {
		expect(repairMixedKindPool(oauth)).toBeUndefined();
		const pool: PooledCredential = {
			type: "api_key",
			key: "a",
			accounts: [
				{ name: "default", key: "a" },
				{ name: "work", key: "b" },
			],
		};
		expect(repairMixedKindPool(pool)).toBeUndefined();
	});

	test("the winning kind keeps its own siblings and a pin that still names one", () => {
		const pool: PooledCredential = {
			type: "api_key",
			key: "k1",
			accounts: [
				{ name: "default", key: "k1" },
				{ name: "personal", access: "a1", refresh: "r1", expires: 5 },
				{ name: "work", access: "a2", refresh: "r2", expires: 6 },
			],
			pinned: "personal",
		};
		expect(repairMixedKindPool(pool)).toEqual({
			credential: {
				type: "oauth",
				access: "a2",
				refresh: "r2",
				expires: 6,
				accounts: [
					{ name: "personal", access: "a1", refresh: "r1", expires: 5 },
					{ name: "work", access: "a2", refresh: "r2", expires: 6 },
				],
				pinned: "personal",
			},
			replaced: "api_key",
		});
	});
});
