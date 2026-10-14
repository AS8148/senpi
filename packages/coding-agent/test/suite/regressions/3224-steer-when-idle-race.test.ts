import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { handleClientInput } from "../../../src/modes/rpc/client-input-handler.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3224: a `steer { whenIdle: "start" }` that arrives right after agent_end, before agent_idle, never
// starts a second concurrent turn and is never left queued on an idle session.

const ROUNDS = 50;

describe("steer whenIdle start in the agent_end window (senpi#3224)", () => {
	let harness: Harness | undefined;
	afterEach(() => harness?.cleanup());

	it("runs every racing steer exactly once, one turn at a time", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		const session = harness.session;
		harness.setResponses(Array.from({ length: 2 * ROUNDS + 2 }, (_, index) => fauxAssistantMessage(`ok ${index}`)));
		const responses: Array<Record<string, unknown>> = [];
		const io = {
			output: (record: object) => responses.push(record as Record<string, unknown>),
			promptCalls: new Set<Promise<unknown>>(),
		};
		let running = 0;
		let maxRunning = 0;
		let pendingRace: number | undefined;
		let raceSent = Promise.withResolvers<Promise<void>>();
		session.subscribe((event) => {
			if (event.type === "agent_start") maxRunning = Math.max(maxRunning, ++running);
			if (event.type !== "agent_end") return;
			running -= 1;
			const round = pendingRace;
			if (round === undefined) return;
			pendingRace = undefined;
			// An RPC client's input arrives on a later macrotask than the agent_end it reacts to.
			setImmediate(() =>
				raceSent.resolve(
					handleClientInput(
						session,
						{
							id: `r${round}`,
							type: "steer",
							message: `race ${round}`,
							clientMessageId: `race-${round}`,
							whenIdle: "start",
						},
						io,
					),
				),
			);
		});

		for (let round = 1; round <= ROUNDS; round++) {
			pendingRace = round;
			await handleClientInput(session, { id: `p${round}`, type: "prompt", message: `turn ${round}` }, io);
			await await raceSent.promise;
			raceSent = Promise.withResolvers<Promise<void>>();
			await Promise.all([...io.promptCalls]);
			await session.waitForIdle();
			expect(session.pendingMessageCount).toBe(0);
		}

		expect(maxRunning).toBe(1);
		expect(session.pendingMessageCount).toBe(0);
		const delivered = session.messages.filter(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("race "),
		);
		expect(delivered).toHaveLength(ROUNDS);
		expect(responses.filter((record) => record.success !== true)).toEqual([]);
	});

	it("two whenIdle starts arriving together on an idle session start exactly one turn; the other joins it", async () => {
		harness = await createHarness({ settings: { retry: { enabled: false } } });
		const session = harness.session;
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		const responses: Array<Record<string, unknown>> = [];
		const io = {
			output: (record: object) => responses.push(record as Record<string, unknown>),
			promptCalls: new Set<Promise<unknown>>(),
		};
		let starts = 0;
		session.subscribe((event) => {
			if (event.type === "agent_start") starts += 1;
		});

		await Promise.all([
			handleClientInput(
				session,
				{ id: "a", type: "steer", message: "first", clientMessageId: "a", whenIdle: "start" },
				io,
			),
			handleClientInput(
				session,
				{ id: "b", type: "follow_up", message: "second", clientMessageId: "b", whenIdle: "start" },
				io,
			),
		]);
		await Promise.all([...io.promptCalls]);
		await session.waitForIdle();

		expect(responses.map((record) => record.success)).toEqual([true, true]);
		const dispositions = responses.map((record) => (record.data as { disposition?: string }).disposition).sort();
		expect(dispositions).toEqual(["queued", "started"]);
		expect(starts).toBe(1);
		expect(session.pendingMessageCount).toBe(0);
	});
});
