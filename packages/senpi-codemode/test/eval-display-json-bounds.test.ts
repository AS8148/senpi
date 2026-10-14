import type { AgentToolResult } from "@code-yeongyu/senpi";
import { describe, expect, it, vi } from "vitest";
import { resolveDisplayOps } from "../src/kernels/js/display-image.js";
import { createEvalTool } from "../src/tool/eval-tool.ts";
import type { RenderEnvironment } from "../src/tool/render-blocks.ts";
import { renderJsonOutputs } from "../src/tool/render-detail.ts";
import { FakeKernel, FakeManager, fakeExtensionContext, result } from "./eval/fakes.ts";
import { plainTheme } from "./eval-render-fixtures.ts";

type ToolContent = AgentToolResult<unknown>["content"][number];
type TextPart = Extract<ToolContent, { type: "text" }>;

function textOf(toolResult: AgentToolResult<unknown>): string {
	return toolResult.content
		.filter((part): part is TextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
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

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

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
	it("Given an object whose buffer field holds image bytes when displayed then it resolves to an image frame plus metadata text", () => {
		// Given: the omowright screenshot shape { buffer, width, height }.
		const value = { buffer: PNG_BYTES, width: 2, height: 3 };

		// When
		const ops = resolveDisplayOps(value);

		// Then
		expect(ops).toEqual([
			{ kind: "text", text: JSON.stringify({ width: 2, height: 3 }) },
			{ kind: "frame", mimeType: "image/png", dataBase64: Buffer.from(PNG_BYTES).toString("base64") },
		]);
	});

	it("Given an object whose buffer field holds non-image bytes when displayed then it stays on the JSON path", () => {
		// Given
		const value = { buffer: new Uint8Array([65, 66, 67]), note: "abc" };

		// When / Then
		expect(resolveDisplayOps(value)).toBeUndefined();
	});

	it("Given an object holding only image bytes under buffer when displayed then just the frame resolves", () => {
		// When
		const ops = resolveDisplayOps({ buffer: PNG_BYTES });

		// Then
		expect(ops).toEqual([
			{ kind: "frame", mimeType: "image/png", dataBase64: Buffer.from(PNG_BYTES).toString("base64") },
		]);
	});
});
