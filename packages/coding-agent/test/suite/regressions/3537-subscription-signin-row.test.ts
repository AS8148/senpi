import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.ts";
import { authMethodStatus, buildLoginProviderInfos, configuredLoginRow } from "../../../src/core/auth-providers.ts";
import type { ModelRegistry } from "../../../src/core/model-registry.ts";
import { isNonStoredSignInFrom } from "../../../src/core/non-stored-sign-in.ts";

/**
 * senpi#3537: the Claude subscription's `check` reports a CLAUDE_CODE_OAUTH_TOKEN or an ambient
 * Claude Code login as a sign-in (`type: "oauth"`), and the router uses it as one, but
 * `get_auth_providers` filed it on the provider's api_key row. Each case below pins one precedence
 * between the sources; the rows are built exactly as `get_auth_providers` builds them.
 */
describe("a non-stored subscription sign-in is reported on the sign-in row (senpi#3537)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.unstubAllEnvs();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	interface Fixture {
		readonly auth?: Record<string, unknown>;
		readonly modelsJson?: Record<string, unknown>;
		readonly runtimeKeys?: Readonly<Record<string, string>>;
	}

	function scratch(): string {
		const root = mkdtempSync(join(tmpdir(), "senpi-3537-"));
		dirs.push(root);
		return root;
	}

	async function registryAndRows(provider: string, fixture: Fixture) {
		const root = scratch();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		if (fixture.auth) writeFileSync(join(agentDir, "auth.json"), JSON.stringify(fixture.auth), { mode: 0o600 });
		if (fixture.modelsJson) writeFileSync(join(agentDir, "models.json"), JSON.stringify(fixture.modelsJson));
		const { modelRegistry, modelRuntime } = await createAgentSessionServices({ cwd, agentDir });
		for (const [id, key] of Object.entries(fixture.runtimeKeys ?? {})) await modelRuntime.setRuntimeApiKey(id, key);
		return { modelRegistry, rows: rowsOf(modelRegistry, provider) };
	}

	async function rowsFor(provider: string, fixture: Fixture = {}) {
		return (await registryAndRows(provider, fixture)).rows;
	}

	function rowsOf(modelRegistry: ModelRegistry, provider: string) {
		const apiKeyRows = new Set(buildLoginProviderInfos(modelRegistry, "api_key").map((info) => info.id));
		const infos = [
			...buildLoginProviderInfos(modelRegistry, "oauth"),
			...buildLoginProviderInfos(modelRegistry, "api_key"),
		].filter((info) => info.id === provider);
		return Object.fromEntries(
			infos.map((info) => [info.authType, authMethodStatus(modelRegistry, info, apiKeyRows.has(info.id))]),
		);
	}

	function loggedInClaude(): string {
		const executable = join(scratch(), "claude");
		writeFileSync(executable, "#!/bin/sh\nexit 0\n");
		chmodSync(executable, 0o755);
		return executable;
	}

	const SUBSCRIPTION_SIGN_IN = { configured: true, source: "environment", label: "Anthropic Subscription" };

	it("env CLAUDE_CODE_OAUTH_TOKEN: on the subscription's sign-in row, not its key row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-scripted-not-a-token");
		expect(await rowsFor("anthropic-subscription")).toEqual({
			oauth: SUBSCRIPTION_SIGN_IN,
			api_key: { configured: false },
		});
	});

	it.skipIf(process.platform === "win32")(
		"ambient Claude Code login (opted in): on the subscription's sign-in row",
		async () => {
			vi.stubEnv("SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION", "ambient");
			vi.stubEnv("SENPI_CLAUDE_SDK_OAUTH_ENABLED", "true");
			vi.stubEnv("CLAUDE_CODE_EXECUTABLE", loggedInClaude());
			expect(await rowsFor("anthropic-subscription")).toEqual({
				oauth: SUBSCRIPTION_SIGN_IN,
				api_key: { configured: false },
			});
		},
	);

	it("a stored credential outranks an env sign-in and keeps its own row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-scripted-not-a-token");
		const rows = await rowsFor("anthropic-subscription", {
			auth: { "anthropic-subscription": { type: "api_key", key: "sk-scripted-stored" } },
		});
		expect(rows).toEqual({ oauth: { configured: false }, api_key: { configured: true, source: "stored" } });
	});

	it("a models.json key outranks the sign-in check and stays on the key row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-scripted-not-a-token");
		vi.stubEnv("SCRIPTED_SUBSCRIPTION_KEY", "sk-scripted-not-a-key");
		const rows = await rowsFor("anthropic-subscription", {
			modelsJson: { providers: { "anthropic-subscription": { apiKey: "$SCRIPTED_SUBSCRIPTION_KEY" } } },
		});
		expect(rows).toEqual({
			oauth: { configured: false },
			api_key: { configured: true, source: "environment", label: "SCRIPTED_SUBSCRIPTION_KEY" },
		});
	});

	it("a runtime --api-key outranks an env sign-in on the RPC rows and on the TUI picker's row", async () => {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-scripted-not-a-token");
		const { modelRegistry, rows } = await registryAndRows("anthropic-subscription", {
			runtimeKeys: { "anthropic-subscription": "sk-scripted-runtime-key" },
		});
		expect(rows).toEqual({ oauth: { configured: false }, api_key: { configured: true, source: "runtime" } });
		const provider = { id: "anthropic-subscription", name: "Anthropic Subscription" };
		expect(configuredLoginRow(modelRegistry, provider, true)?.type).toBe("api_key");
	});

	it("ANTHROPIC_API_KEY stays a key on anthropic and does not light the subscription", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-scripted-not-a-key");
		const anthropic = await rowsFor("anthropic");
		expect(anthropic.api_key).toEqual({ configured: true, source: "environment", label: "ANTHROPIC_API_KEY" });
		if ("oauth" in anthropic) expect(anthropic.oauth).toEqual({ configured: false });
		expect(await rowsFor("anthropic-subscription")).toEqual({
			oauth: { configured: false },
			api_key: { configured: false },
		});
	});

	it("ANTHROPIC_API_KEY beside a subscription token: each on its own provider's row", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-scripted-not-a-key");
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-scripted-not-a-token");
		expect((await rowsFor("anthropic")).api_key).toEqual({
			configured: true,
			source: "environment",
			label: "ANTHROPIC_API_KEY",
		});
		expect(await rowsFor("anthropic-subscription")).toEqual({
			oauth: SUBSCRIPTION_SIGN_IN,
			api_key: { configured: false },
		});
	});

	it("no credential: both subscription rows unconfigured", async () => {
		expect(await rowsFor("anthropic-subscription")).toEqual({
			oauth: { configured: false },
			api_key: { configured: false },
		});
	});

	it("keeps an environment API key on the provider's key row", async () => {
		vi.stubEnv("OPENAI_API_KEY", "sk-scripted-not-a-key");
		const rows = await rowsFor("openai");
		expect(rows.api_key).toEqual({ configured: true, source: "environment", label: "OPENAI_API_KEY" });
		if ("oauth" in rows) expect(rows.oauth).toEqual({ configured: false });
	});
});

describe("non-stored sign-in precedence, independent of the packages/ai check order (senpi#3537)", () => {
	const none = { runtimeKey: false, stored: false, configuredKey: false } as const;
	it.each([
		["a runtime key", { ...none, runtimeKey: true }],
		["a stored credential", { ...none, stored: true }],
		["a configured models.json/extension key", { ...none, configuredKey: true }],
	])("%s beside an oauth check result is not a sign-in", (_name, sources) => {
		expect(isNonStoredSignInFrom({ ...sources, checkType: "oauth" })).toBe(false);
	});

	it("only an oauth check result with nothing ahead of it is a sign-in", () => {
		expect(isNonStoredSignInFrom({ ...none, checkType: "oauth" })).toBe(true);
		expect(isNonStoredSignInFrom({ ...none, checkType: "api_key" })).toBe(false);
		expect(isNonStoredSignInFrom({ ...none, checkType: undefined })).toBe(false);
	});
});
