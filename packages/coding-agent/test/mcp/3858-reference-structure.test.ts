import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	redactResolvedReferenceData,
	rememberResolvedReferenceValue,
} from "../../src/core/config-reference-redaction.ts";
import { readMcpCatalogCache, writeMcpCachedServer } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { referenceRoot, SECRET } from "../suite/regressions/3858-reference-support.ts";

// #3858: redaction must preserve the structured MCP protocol and cache.
describe("reference redaction preserves structure", () => {
	beforeEach(() => {
		for (const value of ["true", "8080", "text", SECRET, "abc"]) rememberResolvedReferenceValue(value);
	});

	it("preserves boolean annotations", () => {
		expect(redactResolvedReferenceData({ annotations: { readOnlyHint: true } })).toEqual({
			annotations: { readOnlyHint: true },
		});
	});

	it("preserves numeric progress", () => {
		expect(redactResolvedReferenceData({ progress: { progress: 8080 } })).toEqual({
			progress: { progress: 8080 },
		});
	});

	// #3858 delta review: a field that names a value's kind is protocol, not payload.
	it("keeps content-block and schema type discriminators while redacting free text", () => {
		const block = [
			{ type: "text", text: `token ${SECRET}` },
			{ type: "image", mimeType: "text", data: "x" },
		];
		expect(redactResolvedReferenceData(block)).toEqual([
			{ type: "text", text: "token <redacted>" },
			{ type: "image", mimeType: "text", data: "x" },
		]);
		expect(
			redactResolvedReferenceData({ inputSchema: { type: "object", properties: { q: { type: "text" } } } }),
		).toEqual({
			inputSchema: { type: "object", properties: { q: { type: "text" } } },
		});
	});

	it("serializes values with toJSON the way JSON would before redacting them", () => {
		const at = new Date("2026-10-24T00:00:00.000Z");
		expect(redactResolvedReferenceData({ at, note: `seen ${SECRET}` })).toEqual({
			at: "2026-10-24T00:00:00.000Z",
			note: "seen <redacted>",
		});
	});

	it("preserves keys and shape while redacting only nested string leaves", () => {
		const original = { text: [{ true: true, "8080": 8080, text: `nested ${SECRET}`, short: "abc", nil: null }] };
		expect(redactResolvedReferenceData(original)).toEqual({
			text: [{ true: true, "8080": 8080, text: "nested <redacted>", short: "abc", nil: null }],
		});
		expect(original.text[0]?.text).toBe(`nested ${SECRET}`);
	});

	it("copies cycles without mutating them or leaving their strings raw", () => {
		const original: { text: string; self?: object } = { text: SECRET };
		original.self = original;
		const redacted = redactResolvedReferenceData(original);
		expect(redacted).not.toBe(original);
		expect(redacted.self).toBe(redacted);
		expect(redacted.text).toBe("<redacted>");
		expect(original.text).toBe(SECRET);
	});

	it("walks deep data without overflowing the stack or skipping leaves", () => {
		type Node = { text?: string; child?: Node };
		const original: Node = {};
		let leaf = original;
		for (let depth = 0; depth < 20_000; depth++) {
			leaf.child = {};
			leaf = leaf.child;
		}
		leaf.text = SECRET;
		let redacted = redactResolvedReferenceData(original);
		while (redacted.child !== undefined) redacted = redacted.child;
		expect(redacted.text).toBe("<redacted>");
	});

	let files: ReturnType<typeof referenceRoot> | undefined;
	afterEach(() => files?.close());

	it("persists catalog boolean annotations and numeric schema values unchanged", async () => {
		files = referenceRoot();
		await writeMcpCachedServer(files.root, "fixture", {
			configHash: "synthetic-hmac",
			credentialIdentity: "none",
			fetchedAt: 8080,
			tools: [
				{
					name: "fixture",
					annotations: { readOnlyHint: true },
					inputSchema: { type: "object", properties: { text: { type: "number", default: 8080 } } },
					description: `nested ${SECRET}`,
				},
			],
			prompts: [],
			resources: [],
		});
		expect((await readMcpCatalogCache(files.root)).servers.fixture).toMatchObject({
			fetchedAt: 8080,
			tools: [
				{
					annotations: { readOnlyHint: true },
					inputSchema: { properties: { text: { default: 8080 } } },
					description: "nested <redacted>",
				},
			],
		});
	});
});
