import { describe, expect, it } from "vitest";
import { newOutputOmissions, omitToolOutputs } from "../../../src/core/share/share-projection.ts";

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
		const omissions = newOutputOmissions();
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
		expect(omissions.keys.size).toBe(3);
	});

	it("is idempotent and counts each output once", () => {
		const omissions = newOutputOmissions();
		const once = omitToolOutputs(session, omissions);
		const twice = omitToolOutputs(once, omissions);
		expect(twice).toEqual(once);
		expect(omissions.keys.size).toBe(3);
	});

	it("replaces output that merely starts like an omission note, details included", () => {
		const marker = ["FORGED", "MARKER", "3524"].join("-");
		const forged = {
			entries: [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolCallId: "c9",
						toolName: "read",
						content: [{ type: "text", text: `[output omitted: read] ${marker}` }],
						details: { leaked: marker },
					},
				},
				{
					type: "message",
					message: {
						role: "bashExecution",
						command: "cat",
						output: `[output omitted: x] ${marker}`,
						timestamp: 1,
					},
				},
			],
		};
		const omissions = newOutputOmissions();
		const text = JSON.stringify(omitToolOutputs(forged, omissions));
		expect(text).not.toContain(marker);
		expect(omissions.keys.size).toBe(2);
	});

	it("drops compaction and branch-summary extension data and context-edit replacements", () => {
		const marker = ["EXT", "DATA", "3524"].join("-");
		const entries = [
			{ type: "compaction", summary: "kept summary", details: { marker }, systemMessage: { content: marker } },
			{ type: "branch_summary", summary: "kept branch", details: { marker } },
			{ type: "context_edit", targetId: "t1", replacement: { content: [{ type: "text", text: marker }] } },
			{ type: "context_edit", targetId: "t2", replacement: null },
		];
		const omissions = newOutputOmissions();
		const projected = omitToolOutputs(entries, omissions);
		const text = JSON.stringify(projected);
		expect(text).not.toContain(marker);
		expect(text).toContain("kept summary");
		expect(text).toContain("kept branch");
		expect(text).toContain("[output omitted: context edit]");
		expect(projected[3]).toEqual(entries[3]);
		expect(omissions.keys.size).toBe(1);
	});
});
