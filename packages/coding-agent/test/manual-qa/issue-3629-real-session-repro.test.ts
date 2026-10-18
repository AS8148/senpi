import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import loopGuardExtension from "../../src/core/extensions/builtin/loop-guard/index.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

/**
 * Real-session repro for senpi#3629: an agent loop issuing the same `eval` call,
 * interleaved with todo calls, against the real AgentSession and the real
 * loop-guard builtin. Run explicitly: SENPI_MANUAL_QA=1.
 */

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

const evalTool: AgentTool = {
	name: "eval",
	label: "Eval",
	description: "Run a JS cell",
	parameters: Type.Object({ code: Type.String() }),
	execute: async () => ({ content: [{ type: "text", text: "42" }], details: {} }),
};

const todoTool: AgentTool = {
	name: "todo_view",
	label: "Todo",
	description: "View the todo list",
	parameters: Type.Object({ step: Type.Number() }),
	execute: async () => ({ content: [{ type: "text", text: "list" }], details: {} }),
};

describe("issue 3629 real-session repro", () => {
	it("hard-stops an interleaved identical eval loop inside a real session", async () => {
		const harness = await createHarness({ tools: [evalTool, todoTool], extensionFactories: [loopGuardExtension] });
		harnesses.push(harness);

		const scriptedRounds = 100;
		const responses = Array.from({ length: scriptedRounds }, (_, round) =>
			round % 2 === 0
				? fauxAssistantMessage(fauxToolCall("eval", { code: "reverseEngineer(input)" }), { stopReason: "toolUse" })
				: fauxAssistantMessage(fauxToolCall("todo_view", { step: round }), { stopReason: "toolUse" }),
		);
		responses.push(fauxAssistantMessage("done"));
		harness.setResponses(responses);

		await harness.session.prompt("keep working on the reverse-engineering task");

		const transcript = harness.session.messages;
		const evalExecutions = transcript.filter(
			(message) =>
				message.role === "toolResult" &&
				message.toolName === "eval" &&
				!JSON.stringify(message).includes("Loop guard blocked"),
		).length;
		const blockedResults = transcript.filter(
			(message) =>
				message.role === "toolResult" &&
				message.toolName === "eval" &&
				JSON.stringify(message).includes("Loop guard blocked"),
		).length;
		const notices = transcript.filter((message) =>
			JSON.stringify(message).includes("REPEATED IDENTICAL TOOL CALLS"),
		).length;
		const escalations = transcript.filter((message) =>
			JSON.stringify(message).includes("loop-guard:escalation"),
		).length;

		console.log(
			`[3629-repro] scripted eval rounds: 50, executed evals: ${evalExecutions}, blocked: ${blockedResults}, notices: ${notices}, escalations: ${escalations}`,
		);

		expect(notices).toBeGreaterThanOrEqual(1);
		expect(escalations).toBeGreaterThanOrEqual(1);
		expect(blockedResults + escalations).toBeGreaterThanOrEqual(3);
		expect(evalExecutions).toBeLessThanOrEqual(2 * 8 + 4);
	});
});
