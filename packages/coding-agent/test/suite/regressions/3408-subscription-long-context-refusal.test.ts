import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { AccountSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { runFailover } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import { registerAnthropicSubscriptionExtension } from "../../../src/core/extensions/builtin/anthropic-subscription/index.ts";
import {
	_resetLongContextForTesting,
	LONG_CONTEXT_REFUSAL_TTL_MS,
	longContextAvailable,
	markLongContextRefused,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import type { ExtensionAPI, ProviderConfig } from "../../../src/core/extensions/types.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";

const REFUSAL =
	"Extra usage is required for long context · enable extra usage at claude.ai/settings/usage (rate_limit)";
const PROVIDER = "anthropic-subscription";
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "senpi-3408-"));
	_resetLongContextForTesting(join(directory, "long-context.json"));
});

afterEach(() => {
	_resetLongContextForTesting();
	rmSync(directory, { recursive: true, force: true });
});

/** The extension's provider registrations applied to a real model runtime, which validates each one. */
async function liveLane(): Promise<{
	window: () => number | undefined;
	shutdown: () => void;
	staleRegistration: () => void;
}> {
	const runtime = getModelRuntime(await createInMemoryModelRegistry(AuthStorage.inMemory()));
	const shutdownHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
	let active = true;
	const pi = new Proxy({} as ExtensionAPI, {
		get: (_target, key) => {
			if (key === "registerProvider")
				return (name: string, config: ProviderConfig) => {
					if (!active) throw new Error("stale extension context");
					void runtime.registerProvider(name, config, { refresh: false });
				};
			if (key === "on")
				return (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
					if (event === "session_shutdown") shutdownHandlers.push(handler);
				};
			return () => undefined;
		},
	});
	registerAnthropicSubscriptionExtension(pi);
	return {
		window: () => runtime.getModel(PROVIDER, "claude-opus-5-5")?.contextWindow,
		shutdown: () => {
			const ctx = { sessionManager: { getSessionId: () => "session-3408" } };
			for (const handler of shutdownHandlers) void handler({ type: "session_shutdown" }, ctx);
		},
		staleRegistration: () => {
			active = false;
		},
	};
}

describe("#3408: an account that refuses the 1M window plans and requests 200k", () => {
	it("re-registers the lane on the real runtime at 200k the moment the refusal is recorded", async () => {
		const lane = await liveLane();
		const before = lane.window();

		markLongContextRefused();

		expect(before).toBe(1_000_000);
		expect(lane.window()).toBe(200_000);
	});

	it("offers 1M again once the refusal expires", async () => {
		const lane = await liveLane();
		const refusedAt = Date.now();
		markLongContextRefused(refusedAt);

		const available = longContextAvailable(refusedAt + LONG_CONTEXT_REFUSAL_TTL_MS);

		expect(available).toBe(true);
		expect(lane.window()).toBe(1_000_000);
	});

	it("still re-registers the live session when an older runtime's extension context is stale", async () => {
		const stale = await liveLane();
		stale.staleRegistration();
		const live = await liveLane();

		expect(() => markLongContextRefused()).not.toThrow();

		expect(live.window()).toBe(200_000);
	});

	it("stops following the refusal state after the session shuts down", async () => {
		const lane = await liveLane();
		lane.shutdown();

		markLongContextRefused();

		expect(lane.window()).toBe(1_000_000);
	});

	it("retries once on the same account without blocking it, after recording the refusal", async () => {
		const account = { name: "main" } as AccountSlot;
		const tried: string[] = [];
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
			store: {} as Parameters<typeof runFailover>[0]["store"],
			providerId: PROVIDER,
			onLongContextRefused: () => markLongContextRefused(),
		})) {
			events.push(event);
		}

		expect(tried).toEqual(["main:1m", "main:200k"]);
		expect(events).toEqual(["answer"]);
	});
});
