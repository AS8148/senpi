import { describe, expect, it } from "vitest";
import { type OutputOmissions, omitToolOutputs } from "../../../src/core/share/share-projection.ts";

// senpi#3524: /share leaves every tool output out by default; tool names and call arguments stay.

const session = {
	entries: [
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "read .env" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: ".env" } }],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "text", text: "A=1" }],
				details: { lines: 1 },
			},
		},
		{ type: "message", message: { role: "bashExecution", command: "env", output: "A=1", fullOutputPath: "/tmp/x" } },
		{ type: "custom_message", customType: "goal", content: "goal text", details: { x: 1 }, display: true },
		{ type: "custom", customType: "state", data: { secret: "s" } },
	],
	renderedTools: { c1: { callHtml: "<b>read .env</b>", resultHtmlCollapsed: "A=1", resultHtmlExpanded: "A=1" } },
};

describe("default share projection (senpi#3524)", () => {
	it("replaces every tool output with a note and keeps the conversation and tool calls", () => {
		const omissions: OutputOmissions = { count: 0 };
		const projected = omitToolOutputs(session, omissions);
		const text = JSON.stringify(projected);

		expect(text).not.toContain("A=1");
		expect(text).not.toContain("/tmp/x");
		expect(text).not.toContain("goal text");
		expect(text).not.toContain('"secret"');
		expect(text).toContain("read .env");
		expect(text).toContain('"arguments":{"path":".env"}');
		expect(text).toContain("[output omitted: read]");
		expect(text).toContain("[output omitted: command]");
		expect(text).toContain("[output omitted: goal]");
		expect(projected.renderedTools).toEqual({ c1: { callHtml: "<b>read .env</b>" } });
		expect(omissions.count).toBe(3);
	});

	it("is idempotent and counts each output once", () => {
		const omissions: OutputOmissions = { count: 0 };
		const once = omitToolOutputs(session, omissions);
		const twice = omitToolOutputs(once, omissions);
		expect(twice).toEqual(once);
		expect(omissions.count).toBe(3);
	});
});
