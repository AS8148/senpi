import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3853 (idle quota drain): a session that stopped with an ACTIVE goal is parked, the host
// restarts and reopens it with `session_start` reason "resume" and nobody attached. Before the fix the
// goal extension queued a continuation on that reopen and every continuation queued the next: 43
// provider calls in about a minute with no client and no input. An unattended reopen must hold every
// engine-originated turn until a client attaches or sends input.

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
});

type FirstSignal = "held" | "turn";

function firstSignal(h: Harness, timeoutMs: number): Promise<FirstSignal | "timeout"> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			unsubscribe();
			resolve("timeout");
		}, timeoutMs);
		const unsubscribe = h.session.subscribe((event: AgentSessionEvent) => {
			const signal: FirstSignal | undefined =
				event.type === "agent_start"
					? "turn"
					: event.type === "entry_appended" &&
							event.entry.type === "custom" &&
							event.entry.customType === "engine-turn-held"
						? "held"
						: undefined;
			if (signal === undefined) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(signal);
		});
	});
}

async function parkedSessionWithActiveGoal(): Promise<{ readonly a: Harness; readonly file: string }> {
	const a = await createHarness({ persistSession: true, extensionFactories: [(pi) => goalExtension(pi)] });
	harnesses.push(a);
	await a.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	a.setResponses([
		fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Keep the docs current" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxText("Goal created; stopping here.")]),
	]);
	await a.session.prompt("set a goal and stop");
	const file = a.sessionManager.getSessionFile();
	if (!file) throw new Error("the session was not persisted");
	return { a, file };
}

it("a host reopen with no client holds the goal continuation and makes zero provider calls", async () => {
	const { a, file } = await parkedSessionWithActiveGoal();
	a.session.dispose();

	const b = await createHarness({
		siblingOf: a,
		sessionManager: SessionManager.open(file),
		extensionFactories: [(pi) => goalExtension(pi)],
		sessionStartEvent: { type: "session_start", reason: "resume", attended: false },
	});
	harnesses.push(b);
	b.setResponses(Array.from({ length: 40 }, (_, i) => fauxAssistantMessage([fauxText(`still working ${i}`)])));
	const before = b.faux.state.callCount;

	const signal = firstSignal(b, 10_000);
	await b.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });

	expect(await signal).toBe("held");
	expect(b.faux.state.callCount - before).toBe(0);
	expect(b.events.some((event) => event.type === "agent_start")).toBe(false);
});
