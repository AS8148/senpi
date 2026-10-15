import type { Api, Model } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { storedKeyHint, verifyApiKey } from "../src/core/verify-api-key.ts";

const KEY = "sk-test-0123456789abcd";

const model = (provider: string, api: Api, baseUrl: string) =>
	({ id: "m", name: "m", provider, api, baseUrl }) as unknown as Model<Api>;

const MODELS = [
	model("openai", "openai-completions", "https://api.example.test/v1/"),
	model("anthropic", "anthropic-messages", "https://anthropic.example.test/v1"),
	model("odd", "bedrock-converse-stream" as Api, "https://bedrock.example.test"),
];

const answering = (status: number) => {
	const seen: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetch = (async (url: string, init?: RequestInit) => {
		seen.push({ url, headers: init?.headers as Record<string, string> });
		return new Response("{}", { status });
	}) as unknown as typeof globalThis.fetch;
	return { fetch, seen };
};

const verify = (provider: string, fetch: typeof globalThis.fetch) =>
	verifyApiKey({ models: MODELS, provider, key: KEY, signal: AbortSignal.timeout(5_000), fetch });

describe("verifyApiKey (desktop #2510)", () => {
	it("reads the provider's model list with the key and answers ok on 2xx", async () => {
		const provider = answering(200);
		expect(await verify("openai", provider.fetch)).toEqual({ ok: true });
		expect(provider.seen[0]?.url).toBe("https://api.example.test/v1/models");
		expect(provider.seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
	});

	it("uses the Anthropic header and path", async () => {
		const provider = answering(200);
		await verify("anthropic", provider.fetch);
		expect(provider.seen[0]?.url).toBe("https://anthropic.example.test/v1/models");
		expect(provider.seen[0]?.headers["x-api-key"]).toBe(KEY);
	});

	it("tells a rejected key from an unreachable provider and an unchecked one", async () => {
		expect(await verify("openai", answering(401).fetch)).toEqual({ ok: false, reason: "rejected", status: 401 });
		expect(await verify("openai", answering(403).fetch)).toEqual({ ok: false, reason: "rejected", status: 403 });
		expect(await verify("openai", answering(503).fetch)).toEqual({
			ok: false,
			reason: "unreachable",
			status: 503,
		});
		expect(await verify("openai", answering(404).fetch)).toEqual({
			ok: false,
			reason: "unsupported",
			status: 404,
		});
		const offline = (async () => {
			throw new TypeError("fetch failed");
		}) as unknown as typeof globalThis.fetch;
		expect(await verify("openai", offline)).toEqual({ ok: false, reason: "unreachable" });
		expect(await verify("odd", answering(200).fetch)).toEqual({ ok: false, reason: "unsupported" });
		expect(await verify("nobody", answering(200).fetch)).toEqual({ ok: false, reason: "unknown-provider" });
	});

	it("never puts the key in its answer", async () => {
		for (const status of [200, 401, 500]) {
			expect(JSON.stringify(await verify("openai", answering(status).fetch))).not.toContain(KEY);
		}
	});
});

const registryWith = (credential: unknown) => ({ authStorage: { get: () => credential } }) as unknown as ModelRegistry;

describe("storedKeyHint (desktop #2510)", () => {
	it("shows exactly the last four characters of an app-stored key", () => {
		expect(storedKeyHint(registryWith({ type: "api_key", key: KEY }), { id: "openai", authType: "api_key" })).toEqual(
			{
				keyHint: "abcd",
			},
		);
	});

	it("hints nothing for OAuth, command or env references, or short keys", () => {
		const row = { id: "openai", authType: "api_key" as const };
		expect(storedKeyHint(registryWith({ type: "oauth" }), row)).toEqual({});
		expect(storedKeyHint(registryWith({ type: "api_key", key: KEY }), { id: "openai", authType: "oauth" })).toEqual(
			{},
		);
		expect(storedKeyHint(registryWith({ type: "api_key", key: "!op read op://vault/key" }), row)).toEqual({});
		expect(storedKeyHint(registryWith({ type: "api_key", key: "$OPENAI_API_KEY" }), row)).toEqual({});
		expect(storedKeyHint(registryWith({ type: "api_key", key: "short-key" }), row)).toEqual({});
		expect(storedKeyHint(registryWith(undefined), row)).toEqual({});
	});
});
