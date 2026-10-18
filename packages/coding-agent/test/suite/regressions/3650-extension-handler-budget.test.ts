// senpi#3650 regression: one extension handler that never settles on the agent event queue froze the session.
// The turn's messages were never persisted, the session stayed streaming, and queued input was never delivered.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionError } from "../../../src/core/extensions/types.ts";
import type { Settings } from "../../../src/core/settings-manager.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

const HANDLER_TIMEOUT_MS = 100;
const NOTIFICATION = "senpi-monitor:notification";
const never = (): Promise<void> => new Promise<void>(() => {});

type HeldEvent = "agent_start" | "message_end" | "agent_settled";

function withinRealTime<T>(work: Promise<T>, what: string, ms = 10_000): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setRealTimeout(() => reject(new Error(`still waiting for ${what} after ${ms} ms`)), ms);
		work.then(
			(value) => {
				clearRealTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearRealTimeout(timer);
				reject(error);
			},
		);
	});
}

function holdOnMonitorTurn(event: HeldEvent, capture: { api?: ExtensionAPI }) {
	return (pi: ExtensionAPI): void => {
		capture.api = pi;
		let monitorTurn = false;
		let held = false;
		pi.on("message_start", (payload) => {
			if (payload.message.role === "custom" && payload.message.customType === NOTIFICATION) monitorTurn = true;
		});
		const holdOnce = async (): Promise<void> => {
			if (held) return;
			held = true;
			await never();
		};
		if (event === "agent_start") {
			let starts = 0;
			pi.on("agent_start", async () => {
				starts += 1;
				if (starts === 2) await holdOnce();
			});
		} else if (event === "message_end") {
			pi.on("message_end", async (payload) => {
				if (payload.message.role === "custom" && payload.message.customType === NOTIFICATION) await holdOnce();
			});
		} else {
			pi.on("agent_settled", async () => {
				if (monitorTurn) await holdOnce();
			});
		}
	};
}

function sessionLogEvents(harness: Harness): Array<Record<string, unknown>> {
	const path = join(harness.tempDir, "agent", "logs", "session.log");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function customMessageTypes(harness: Harness): string[] {
	return harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom_message" ? [entry.customType] : []));
}

describe("senpi#3650 a hung extension handler cannot freeze the session", () => {
	let harness: Harness;

	afterEach(() => {
		vi.useRealTimers();
		harness?.cleanup();
	});

	async function startHeld(event: HeldEvent, settings: Partial<Settings>) {
		const capture: { api?: ExtensionAPI } = {};
		harness = await createHarness({ settings, extensionFactories: [holdOnMonitorTurn(event, capture)] });
		const errors: ExtensionError[] = [];
		harness.getExtensionRunner().onError((error) => errors.push(error));
		harness.setResponses([
			fauxAssistantMessage([fauxText("reply 1")]),
			fauxAssistantMessage([fauxText("reply to monitor")]),
			fauxAssistantMessage([fauxText("reply to steer")]),
		]);
		await harness.session.prompt("start");
		await harness.session.waitForIdle();
		const api = capture.api;
		if (api === undefined) throw new Error("extension did not load");
		return { api, errors };
	}

	it.each<HeldEvent>(["agent_start", "message_end", "agent_settled"])(
		"releases a %s handler that never settles, persists the turn, and delivers a queued steer once",
		async (event) => {
			// given an extension whose %s handler never settles on the turn a monitor notification starts
			const { api, errors } = await startHeld(event, {
				extensionEventHandlerWarnMs: 0,
				extensionEventHandlerTimeoutMs: HANDLER_TIMEOUT_MS,
			});

			// when the monitor notification starts a turn and the user steers while it is held
			api.sendMessage({ customType: NOTIFICATION, content: "monitor event", display: false }, { triggerTurn: true });
			const steering = harness.session.prompt("late steer", { streamingBehavior: "steer" });
			await withinRealTime(steering, "the steer to be accepted");
			await withinRealTime(harness.session.waitForIdle(), "the session to settle");
			await withinRealTime(harness.session.waitForSettledSessionWork(), "session work to settle");

			// then the host stopped waiting, said which handler held it, persisted the turn and delivered the steer once
			expect(errors.filter((error) => error.event === event).map((error) => error.error)).toEqual([
				`handler timed out after ${HANDLER_TIMEOUT_MS}ms`,
			]);
			expect(sessionLogEvents(harness)).toContainEqual(
				expect.objectContaining({ event: "extension_handler_stalled", handlerEvent: event, stage: "timeout" }),
			);
			expect(customMessageTypes(harness)).toContain(NOTIFICATION);
			expect(getAssistantTexts(harness)).toContain("reply to monitor");
			expect(getUserTexts(harness).filter((text) => text === "late steer")).toHaveLength(1);
			expect(getAssistantTexts(harness)).toContain("reply to steer");
			expect(harness.session.isStreaming).toBe(false);
		},
		30_000,
	);

	it("lets the turn deadline release a held handler when the handler budget is disabled", async () => {
		// given no handler budget and a 60 s inactivity lease, and an agent_start handler that never settles
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
		const { api } = await startHeld("agent_start", {
			extensionEventHandlerWarnMs: 0,
			extensionEventHandlerTimeoutMs: 0,
			turn_inactivity_ms: 60_000,
			turn_max_runtime_ms: 0,
		});

		// when a monitor notification starts the held turn and the lease runs out
		api.sendMessage({ customType: NOTIFICATION, content: "monitor event", display: false }, { triggerTurn: true });
		await vi.advanceTimersByTimeAsync(60_000);
		await vi.advanceTimersByTimeAsync(10_000);
		await vi.advanceTimersByTimeAsync(10_000);
		vi.useRealTimers();
		await withinRealTime(harness.session.waitForIdle(), "the session to settle after the deadline");

		// then the deadline settled the session instead of only reporting it as unsettled
		expect(harness.session.isStreaming).toBe(false);
		expect(customMessageTypes(harness)).toContain(NOTIFICATION);
		const logged = sessionLogEvents(harness);
		expect(logged).toContainEqual(
			expect.objectContaining({
				event: "extension_handler_stalled",
				handlerEvent: "agent_start",
				stage: "released",
			}),
		);
		expect(logged.filter((line) => line.event === "turn_deadline_unsettled")).toEqual([]);
	}, 30_000);
});
