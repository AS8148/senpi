import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});
const wake = { customType: "senpi-monitor:event", content: "continue", display: false };
const starts = (h: Harness) =>
	h.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "engine-turn-start");
const limits = (h: Harness) =>
	h.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "engine-turn-limit");

// senpi#3853: queued triggers must count before they can escape through a different turn path.
it("counts every engine trigger admitted while streaming and stops at the resume cap", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume" },
		settings: { engineTurns: { maxToolFreePerMinute: 0 } },
		tools: [
			{
				name: "barrier",
				label: "Barrier",
				description: "Wait for the test to release streaming admission.",
				parameters: Type.Object({}),
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("barrier", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 20 }, () => fauxAssistantMessage([fauxText("done")])),
	]);
	const firstTurn = h.session.sendCustomMessage(wake, { triggerTurn: true });
	await entered.promise;
	expect(h.session.isStreaming).toBe(true);
	try {
		for (let i = 0; i < 9; i++) {
			await h.session.sendCustomMessage(wake, { triggerTurn: true, deliverAs: "followUp" });
		}
	} finally {
		release.resolve();
		await firstTurn;
	}
	expect(starts(h)).toHaveLength(8);
	expect(limits(h)).toHaveLength(2);
	// Native background queues coalesce the seven accepted notices, but admission counted all seven.
	expect(h.faux.state.callCount).toBe(3);
});

it("counts triggers arriving during a pending compaction admission, even when it is rejected", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await createHarness({
		sessionStartEvent: { type: "session_start", reason: "resume" },
		settings: { compaction: { enabled: true, keepRecentTokens: 1 }, engineTurns: { maxToolFreePerMinute: 0 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async () => {
					entered.resolve();
					await release.promise;
					return { cancel: true, rejectionCause: "cancelled-by-extension" as const };
				});
			},
		],
	});
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage([fauxText("seed context")])]);
	// Seed through an engine turn so no real input ends this resume window.
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	const compaction = h.session.compact().catch(() => undefined);
	expect(h.session.isCompacting).toBe(true);
	const triggers = Array.from({ length: 9 }, () => h.session.sendCustomMessage(wake, { triggerTurn: true }));
	await entered.promise;
	release.resolve();
	await Promise.all([compaction, ...triggers]);
	expect(starts(h)).toHaveLength(8);
	expect(limits(h)).toHaveLength(2);
	expect(h.faux.state.callCount).toBe(1);
	expect(h.agent.hasQueuedMessages()).toBe(true);
});

it("includes loaded history in the eight-turn resume cap and resets only on real input", async () => {
	const a = await createHarness({ persistSession: true, settings: { engineTurns: { maxToolFreePerMinute: 0 } } });
	harnesses.push(a);
	a.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText("seed")])));
	await a.session.prompt("initial input");
	for (let i = 0; i < 3; i++) await a.session.sendCustomMessage(wake, { triggerTurn: true });
	const file = a.sessionManager.getSessionFile()!;
	a.session.dispose();
	const b = await createHarness({
		siblingOf: a,
		sessionManager: SessionManager.open(file),
		sessionStartEvent: { type: "session_start", reason: "resume" },
		settings: { engineTurns: { maxToolFreePerMinute: 0 } },
	});
	harnesses.push(b);
	b.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage([fauxText("progress")])));
	const before = b.faux.state.callCount;
	for (let i = 0; i < 10; i++) await b.session.sendCustomMessage(wake, { triggerTurn: true });
	expect(b.faux.state.callCount - before).toBe(5);
	expect(starts(b)).toHaveLength(8);
	expect(limits(b).at(-1)).toMatchObject({ data: { reason: "resume-window", sinceUserInput: 8 } });
	expect(
		b.sessionManager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "engine-paused"),
	).toBe(true);
	await b.session.prompt("new input");
	const afterInput = b.faux.state.callCount;
	for (let i = 0; i < 9; i++) await b.session.sendCustomMessage(wake, { triggerTurn: true });
	expect(b.faux.state.callCount - afterInput).toBe(9);
	expect(b.settingsManager.getEngineTurnSettings().maxPerUserInput).toBe(150);
});
