// senpi#3864 (review r4 finding 1): a turn end is bound to its run when its agent_end is emitted. The agent core can
// drain queued input into run B before the session's event queue reaches run A's agent_end, so A's late end must not
// label or show its stop on B.
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import {
	TODO_OWED_REMINDER_EVENT,
	type TodoOwedReminderEvent,
} from "../../../src/core/extensions/builtin/goal/todo-owed-backstop.ts";
import todotoolsExtension from "../../../src/core/extensions/builtin/todotools/index.ts";
import type { LifecycleRecord } from "../../../src/core/lifecycle-record.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function lifecycleRecords(harness: Harness): LifecycleRecord[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom" && entry.customType === "session-lifecycle")
		.map((entry) => (entry as { data: LifecycleRecord }).data);
}

it("keeps a run's late todo cap off the run the core drained before that end was processed", async () => {
	// Given a root with open todos, no goal and no on-duty source, whose reminder chain is spent by run A (the third
	// run), and no agent_before_settle handler, so queued input is drained by the core itself.
	const reminders: TodoOwedReminderEvent[] = [];
	const coreStartsAtEnd: number[] = [];
	let coreStarts = 0;
	const h = await createHarness({
		extensionFactories: [
			todotoolsExtension,
			goalExtension,
			(pi) => {
				pi.events.on(TODO_OWED_REMINDER_EVENT, (data) => reminders.push(data as TodoOwedReminderEvent));
				pi.on("agent_end", () => {
					coreStartsAtEnd.push(coreStarts);
				});
			},
		],
		fileSettings: true,
		settings: { todo: { firstTurnPlan: "off" } },
	});
	harnesses.push(h);
	await h.session.bindExtensions({ mode: "rpc" });
	// An extension follow-up lands in the agent queue at A's agent_end emission, after the loop's last poll.
	h.session.agent.subscribe((event) => {
		if (event.type === "agent_start") coreStarts += 1;
		if (event.type !== "agent_end" || coreStarts !== 3) return;
		h.session.agent.followUp({
			role: "custom",
			customType: "test-follow-up",
			content: [{ type: "text", text: "A watched job finished." }],
			display: false,
			timestamp: Date.now(),
		});
	});
	h.setResponses([
		fauxAssistantMessage(
			[fauxToolCall("todo", { op: "init", list: [{ phase: "Build", items: ["Write the parser", "Wire it"] }] })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Working on the parser."),
		fauxAssistantMessage("Still on the parser."),
		fauxAssistantMessage("Pausing the parser here."),
		fauxAssistantMessage([fauxToolCall("todo", { op: "done", phase: "Build" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The parser is written and wired."),
	]);

	// When run A ends and the core drains the follow-up as run B before A's queued end is processed.
	await h.session.prompt("Write and wire the parser.");
	await h.session.waitForSettledSessionWork();

	// Then A's end really was processed after B started, and A's own end capped the todo chain.
	expect(coreStarts).toBe(4);
	expect(coreStartsAtEnd[2]).toBe(4);
	expect(reminders.map((event) => event.reason)).toEqual(["delivered", "delivered", "capped"]);

	// And no record of B, while it runs or after it ends cleanly, nor the live snapshot, carries A's stop.
	const runB = lifecycleRecords(h).at(-1)?.runId;
	const recordsB = lifecycleRecords(h).filter((record) => record.runId === runB);
	expect(recordsB.some((record) => record.state === "running" && record.runActive)).toBe(true);
	for (const record of recordsB) expect(record.lastStop).toBeUndefined();
	expect(h.session.lifecycle.lastStop).toBeUndefined();

	// And a reload after B restores no stop.
	const { SessionLifecycleController } = await import("../../../src/core/session-lifecycle.ts");
	const reloaded = new SessionLifecycleController({
		sessionId: h.sessionManager.getSessionId(),
		entries: h.sessionManager.getEntries(),
		append: () => {},
		appendChild: () => {},
		appendCustody: () => {},
		emit: () => {},
		readRuntime: () => ({
			activity: {
				isStreaming: false,
				isBashRunning: false,
				isCompacting: false,
				hasSessionWork: false,
				hasActiveWakeSource: false,
			},
			pendingMessages: 0,
			human: [],
			holds: [],
		}),
	});
	reloaded.restoreComplete();
	expect(reloaded.snapshot.lastStop).toBeUndefined();
});
