import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	CREDENTIAL_POOL_STATE_FILENAME,
	CredentialSlotRepository,
} from "../../../src/core/credential-pool/state-store.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

// senpi#3216: unused ChatGPT subscription accounts carried 31-34 hour `rate_limit` blocks while
// their 5-hour and weekly quota were untouched; removing and re-adding them cleared it. The
// cooldown was 60 s * 2^failureCount, and failureCount only ever grew: a success cleared the block
// but kept the count, and every request-scoped 429 that rotated through the pool raised the count of
// each slot it touched. After eleven such incidents over an account's lifetime, one more plain 429
// blocked it for 2^11 minutes (34 h).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-3216-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function twoAccounts(): PooledCredential {
	return {
		type: "api_key",
		key: "key-default",
		accounts: [
			{ name: "default", key: "key-default", source: "login" },
			{ name: "work", key: "key-work", source: "login" },
		],
	};
}

async function runtimeWith(credential: PooledCredential) {
	const faux = fauxProvider();
	const credentials = AuthStorage.inMemory();
	await credentials.modify("faux", async () => credential);
	const runtime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		agentDir: dir,
		allowModelNetwork: false,
	});
	await runtime.registerNativeProvider(faux.provider);
	await runtime.refresh({ allowNetwork: false, providers: ["faux"] });
	return { faux, runtime };
}

function repository() {
	return new CredentialSlotRepository(join(dir, CREDENTIAL_POOL_STATE_FILENAME));
}

async function seedFailureHistory(name: string, key: string, failureCount: number): Promise<void> {
	const credentialRevision = await repository().storedCredentialRevision("faux", name, { key });
	await repository().mutateSlotState("faux", "stored", name, () => ({ failureCount, credentialRevision }));
}

function throttled() {
	return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 Too Many Requests" });
}

async function collectClosed(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done" || event.type === "error") break;
	}
	return events;
}

describe("senpi#3216 credential-pool blocks stay proportional to the evidence", () => {
	test("a success resets the failure history, so the next plain 429 cools the account for minutes, not a day", async () => {
		// given - both accounts carry ten old transient failures; the session's account serves once.
		await seedFailureHistory("default", "key-default", 10);
		await seedFailureHistory("work", "key-work", 10);
		const { faux, runtime } = await runtimeWith(twoAccounts());
		faux.setResponses([fauxAssistantMessage("served"), throttled(), fauxAssistantMessage("served by the sibling")]);
		await collectClosed(runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "issue-3216" }));
		const servedFirst = Object.entries(await repository().listSlots("faux", "stored")).find(
			([, slot]) => slot.lastSuccessAt !== undefined,
		)?.[0];
		expect(servedFirst).toBeDefined();

		// when - the same session's account answers one plain 429.
		const before = Date.now();
		await collectClosed(runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "issue-3216" }));

		// then - that account cools for the base cooldown, and the sibling served the request.
		const slots = await repository().listSlots("faux", "stored");
		const blocked = slots[servedFirst ?? ""];
		expect(blocked?.blockReason).toBe("rate_limit");
		expect((blocked?.blockedUntil ?? 0) - before).toBeLessThanOrEqual(2 * MINUTE);
	});

	test("without a reset hint from the provider, repeated 429s never block an account for longer than an hour", async () => {
		// given - an account that kept failing (no success in between); its sibling is healthy.
		await seedFailureHistory("default", "key-default", 10);
		await seedFailureHistory("work", "key-work", 10);
		const { faux, runtime } = await runtimeWith(twoAccounts());
		faux.setResponses([throttled(), fauxAssistantMessage("served by the sibling")]);

		// when
		const before = Date.now();
		const events = await collectClosed(
			runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "issue-3216-cap" }),
		);

		// then - the hintless backoff stops at an hour; a 2^11-minute block needs the provider to say so.
		expect(events.at(-1)?.type).toBe("done");
		const blocked = Object.values(await repository().listSlots("faux", "stored")).filter(
			(slot) => slot.blockReason === "rate_limit",
		);
		expect(blocked).toHaveLength(1);
		expect((blocked[0]?.blockedUntil ?? 0) - before).toBeLessThanOrEqual(HOUR + MINUTE);
	});

	test("a provider reset hint still sets the block, however far away it is", async () => {
		// given
		const { faux, runtime } = await runtimeWith(twoAccounts());
		faux.setResponses([
			fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "You've hit your weekly usage limit \u00b7 resets in 30 hours",
			}),
			fauxAssistantMessage("served by the sibling"),
		]);

		// when
		const before = Date.now();
		await collectClosed(runtime.stream(faux.getModel(), { messages: [], tools: [] }, { sessionId: "issue-3216-hint" }));

		// then
		const blocked = Object.values(await repository().listSlots("faux", "stored")).filter(
			(slot) => slot.blockReason === "rate_limit",
		);
		expect(blocked).toHaveLength(1);
		expect(blocked[0]?.blockedUntil ?? 0).toBeGreaterThanOrEqual(before + 30 * HOUR);
	});
});
