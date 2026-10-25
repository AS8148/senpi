import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { cachedToolsToCatalogEntries, collectToolCatalog } from "../../src/core/extensions/builtin/mcp/catalog.ts";
import {
	collectServerCatalogForCache,
	readMcpCatalogCache,
	writeMcpCachedServer,
} from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { normalizeServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import {
	buildMcpToolDefinitions,
	executeMcpCatalogEntry,
} from "../../src/core/extensions/builtin/mcp/expose/register.ts";
import { compileModernSchema } from "../../src/core/extensions/builtin/mcp/modern/tool-schema.ts";
import { callMcpToolRequest, listMcpTools } from "../../src/core/extensions/builtin/mcp/tool-client.ts";
import { cleanupMrtrConnections, connect } from "./fixtures/mrtr-connection.ts";
import { cleanupRoots, makeRoot } from "./fixtures/service-lifecycle.ts";

const roots: Array<() => Promise<void>> = [];
afterEach(async () => {
	await cleanupMrtrConnections();
	await cleanupRoots(roots);
});

// senpi#4191: validate the real modern wire data, not an object-shaped substitute.
describe("modern schema validation", () => {
	it.each([
		{ schema: { type: "null" }, value: null },
		{ schema: { type: "boolean" }, value: false },
		{ schema: { type: "number" }, value: 0 },
		{ schema: { type: "string" }, value: "" },
		{ schema: { type: "array", prefixItems: [{ type: "integer" }], items: false }, value: [1] },
		{ schema: true, value: { any: [false, null] } },
	])("accepts structuredContent $value against $schema", async ({ schema, value }) => {
		const { connection } = await connect([{ content: [], structuredContent: value }], false, false);
		const result = await callMcpToolRequest(connection.client, { name: "fixture" }, schema);
		expect(result.structuredContent).toEqual(value);
	});

	it.each([
		{ schema: { type: "number" }, result: { structuredContent: "0" } },
		{ schema: { type: "null" }, result: {} },
		{ schema: false, result: { structuredContent: null } },
		{
			schema: { type: "array", prefixItems: [{ type: "integer" }], items: false },
			result: { structuredContent: [1, 2] },
		},
	])("rejects missing or invalid structured output without coercion", async ({ schema, result }) => {
		const { connection } = await connect([{ content: [], ...result }], false, false);
		await expect(callMcpToolRequest(connection.client, { name: "fixture" }, schema)).rejects.toMatchObject({
			code: "MCP_OUTPUT_SCHEMA_MISMATCH",
		});
	});

	it("does not require structured output on an execution error", async () => {
		const { connection } = await connect([{ content: [], isError: true }], false, false);
		await expect(callMcpToolRequest(connection.client, { name: "fixture" }, false)).resolves.toMatchObject({
			isError: true,
		});
	});

	it.each([
		{ schema: { $schema: "https://example.invalid/dialect" }, code: "MCP_SCHEMA_UNSUPPORTED_DIALECT" },
		{ schema: { $ref: "https://example.invalid/schema" }, code: "MCP_SCHEMA_INVALID" },
		{ schema: { type: "bogus" }, code: "MCP_SCHEMA_INVALID" },
	])("rejects invalid definitions at discovery: $code", async ({ schema, code }) => {
		const { connection, script } = await connect([], false, false);
		script.tools = [{ name: "fixture", inputSchema: schema }];
		await expect(listMcpTools(connection.client)).rejects.toMatchObject({ code });
	});

	it("enforces ref siblings and unevaluatedProperties without rewriting arguments", async () => {
		const { connection, script } = await connect([], false, false);
		script.tools = [
			{
				name: "fixture",
				inputSchema: {
					$defs: { count: { type: "integer", minimum: 0 } },
					type: "object",
					properties: { count: { $ref: "#/$defs/count", maximum: 5 } },
					unevaluatedProperties: false,
				},
			},
		];
		const entries = await collectToolCatalog("fixture", connection, normalizeServer({ command: "unused" }));
		const tool = buildMcpToolDefinitions(entries)[0];
		if (!tool) throw new Error("Expected fixture");
		const invalid: ToolCall["arguments"][] = [{ count: 6 }, { count: "3" }, { count: 3, extra: 1 }];
		for (const args of invalid) {
			expect(() =>
				validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: args }),
			).toThrow();
		}
		expect(script.requests).toEqual([]);
	});

	it("round trips raw schemas and protocol era through the persistent cache", async () => {
		const root = makeRoot("schema-cache", roots);
		const { connection, script } = await connect([{ content: [], structuredContent: false }], false, false);
		script.tools = [{ name: "fixture", inputSchema: true, outputSchema: { type: "boolean" } }];
		const catalog = await collectServerCatalogForCache(connection, { requestTimeoutMs: 10_000 }, "schema-config");
		await writeMcpCachedServer(root.agentDir, "fixture", catalog);
		const cached = (await readMcpCatalogCache(root.agentDir)).servers.fixture;
		expect(cached?.tools).toEqual(catalog.tools);
		if (!cached) throw new Error("Missing cached catalog");
		const entries = cachedToolsToCatalogEntries("fixture", cached, connection, 10_000, async () => {});
		const entry = entries[0];
		if (!entry) throw new Error("Expected cached fixture");
		const result = await executeMcpCatalogEntry(entry, {}, undefined, undefined);
		expect(result.content).toEqual([{ type: "text", text: "false" }]);
	});

	it("bounds schema depth and isolates identical schema identifiers", () => {
		let deep: Record<string, unknown> = { type: "object" };
		for (let index = 0; index < 70; index++) deep = { allOf: [deep] };
		expect(() => compileModernSchema(deep)).toThrow(expect.objectContaining({ code: "MCP_SCHEMA_LIMIT" }));
		const first = compileModernSchema({ $id: "urn:test:schema", const: 1 });
		const second = compileModernSchema({ $id: "urn:test:schema", const: 2 });
		expect([first(1), first(2), second(1), second(2)]).toEqual([true, false, false, true]);
	});
});
