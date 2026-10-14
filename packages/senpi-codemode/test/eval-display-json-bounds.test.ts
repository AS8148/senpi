import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import type { KernelToHostMessage } from "../src/bridge/protocol.ts";
import { JavaScriptKernel } from "../src/kernels/js/context-manager.ts";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { RenderEnvironment } from "../src/tool/render-blocks.ts";
import { renderJsonOutputs } from "../src/tool/render-detail.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";
import { plainTheme } from "./eval-render-fixtures.ts";

type ToolContent = AgentToolResult<unknown>["content"][number];
function textOf(toolResult: AgentToolResult<unknown>): string {
	return toolResult.content.flatMap((part: ToolContent) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function createTool(kernel: FakeKernel) {
	return createEvalTool({
		enabledLanguages: { py: false, js: true, rb: false, jl: false },
		kernelManager: new FakeManager([["js", kernel]]),
		cellTimeoutSeconds: 30,
		executeTool: vi.fn(),
	});
}

function renderEnvironment(expanded: boolean): RenderEnvironment {
	return { expanded, theme: plainTheme(), spinnerFrame: undefined, width: 80, meta: undefined, now: 0 };
}

describe("eval display jsonOutputs bounds (#3261)", () => {
	it("Given a displayed object wrapping a large Buffer when the cell settles then the stored jsonOutputs entry is bounded", async () => {
		// Given: the exact payload the JS kernel emits for display({ buffer, width, height }):
		// Buffer#toJSON explodes the bytes into one number per byte.
		const value = { buffer: Buffer.alloc(3_000_000), width: 1, height: 1 };
		const kernel = new FakeKernel([
			{
				type: "display",
				mimeType: "application/json",
				dataBase64: Buffer.from(JSON.stringify(value)).toString("base64"),
			},
			result("bounded-display", "done"),
		]);

		// When
		const toolResult = await createTool(kernel).execute(
			"bounded-display",
			{ language: "js", code: "display(shot)", summary: "bounded display" },
			undefined,
			undefined,
			fakeExtensionContext(),
		);

		// Then: the stored entry keeps the metadata, replaces the bytes with a placeholder,
		// and stays within the same order of budget as the model-facing text.
		const stored = toolResult.details.jsonOutputs;
		expect(stored).toHaveLength(1);
		if (stored === undefined) throw new Error("jsonOutputs missing from eval result details");
		expect(stored[0]).toEqual({ buffer: "<Buffer 2.9 MB>", width: 1, height: 1 });
		expect(JSON.stringify(stored[0]).length).toBeLessThan(16_000);
		// And the model-facing text still renders the capped JSON tree.
		expect(textOf(toolResult)).toContain("display[1]:");
	});

	it("Given a legacy oversized stored Buffer entry when rendered then a bounded placeholder line is shown", () => {
		// Given: an entry as stored by sessions before the storage bound existed.
		const legacy = { type: "Buffer", data: new Array(3_000_000).fill(0), width: 1, height: 1 };

		// When
		const collapsed = renderJsonOutputs([legacy], renderEnvironment(false));
		const expanded = renderJsonOutputs([legacy], renderEnvironment(true));

		// Then
		expect(collapsed.join("\n")).toContain("<Buffer 2.9 MB>");
		expect(collapsed.length).toBeLessThanOrEqual(4);
		expect(expanded.join("\n")).toContain("<Buffer 2.9 MB>");
		expect(expanded.length).toBeLessThanOrEqual(4);
	});

	it("Given a legacy oversized stored entry when rendered then a bounded summary replaces the tree", () => {
		// Given: a stored entry far beyond the display text budget with no Buffer shape.
		const legacy = { payload: "x".repeat(200_000) };

		// When
		const lines = renderJsonOutputs([legacy], renderEnvironment(true));

		// Then
		expect(lines.join("\n")).toContain("oversized");
		expect(lines.length).toBeLessThanOrEqual(4);
	});

	it("Given a malformed stored entry when rendered then the failure stays local to the entry", () => {
		// Given: an entry whose key enumeration throws.
		const malformed = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("boom");
				},
				getOwnPropertyDescriptor() {
					throw new Error("boom");
				},
			},
		);

		// When / Then: one bad entry must not take down the component, and good entries still render.
		let lines: string[] = [];
		expect(() => {
			lines = renderJsonOutputs([malformed, { ok: 1 }], renderEnvironment(false));
		}).not.toThrow();
		expect(lines.join("\n")).toContain("could not be rendered");
		expect(lines.join("\n")).toContain("ok");
	});
});

describe("eval display wrapped image detection (#3261)", () => {
	async function displayEvents(code: string): Promise<KernelToHostMessage[]> {
		const kernel = new JavaScriptKernel({
			sessionId: "wrapped-buffer-detection",
			cwd: process.cwd(),
			parallelPoolWidth: 1,
			onMessage: () => {},
		});
		const messages: KernelToHostMessage[] = [];
		try {
			await kernel.run({
				cellId: `cell-${crypto.randomUUID()}`,
				code,
				timeoutMs: 5_000,
				onMessage: (message) => messages.push(message),
			});
		} finally {
			await kernel.close();
		}
		return messages.filter((message) => message.type === "display" || message.type === "text");
	}

	it("Given an object whose buffer field holds image bytes when displayed then it resolves to an image frame plus metadata text", async () => {
		// Given: the omowright screenshot shape { buffer, width, height }.
		const events = await displayEvents(
			"display({ buffer: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]), width: 2, height: 3 })",
		);

		// Then: the metadata displays as compact JSON stdout text, then the bytes as an image frame.
		expect(events).toEqual([
			{ type: "text", stream: "stdout", data: `${JSON.stringify({ width: 2, height: 3 })}\n` },
			{
				type: "display",
				mimeType: "image/png",
				dataBase64: Buffer.from(
					new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
				).toString("base64"),
			},
		]);
	});

	it("Given an object whose buffer field holds non-image bytes when displayed then it stays on the JSON path", async () => {
		const events = await displayEvents("display({ buffer: new Uint8Array([65,66,67]), note: 'abc' })");

		// Then: one JSON display carrying the serialized bytes, no image frame.
		expect(events).toHaveLength(1);
		const display = events[0];
		expect(display.type).toBe("display");
		if (display.type !== "display") return;
		expect(display.mimeType).toBe("application/json");
		expect(JSON.parse(Buffer.from(display.dataBase64, "base64").toString("utf8"))).toEqual({
			buffer: { 0: 65, 1: 66, 2: 67 },
			note: "abc",
		});
	});

	it("Given an object holding only image bytes under buffer when displayed then just the frame resolves", async () => {
		const events = await displayEvents(
			"display({ buffer: new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]) })",
		);

		// Then
		expect(events).toEqual([
			{
				type: "display",
				mimeType: "image/png",
				dataBase64: Buffer.from(
					new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
				).toString("base64"),
			},
		]);
	});
});
