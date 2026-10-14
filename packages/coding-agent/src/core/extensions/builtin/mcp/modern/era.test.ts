import { describe, expect, it, vi } from "vitest";
import { type ProbeRequest, probeHttpEra, probeStdioEra } from "./era.ts";

const options = {
	clientInfo: { name: "senpi", version: "test" },
	clientCapabilities: { elicitation: {} },
	supportedVersions: ["2026-07-28", "2026-06-01"],
};
const discovery = {
	jsonrpc: "2.0",
	id: 1,
	result: {
		resultType: "complete",
		supportedVersions: ["2026-07-28"],
		capabilities: { tools: {} },
		_meta: { "io.modelcontextprotocol/serverInfo": { name: "fixture", version: "1" } },
	},
};
const rpcError = (code: number, message: string, data: unknown = {}) => ({
	jsonrpc: "2.0",
	id: 1,
	error: { code, message, data },
});
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("HTTP era detection", () => {
	it("detects modern discovery and sends matching per-request metadata and headers", async () => {
		const fetch = vi.fn(async (_url: URL, _init: RequestInit) => reply(discovery));
		const result = await probeHttpEra(new URL("https://fixture.test/mcp"), fetch, options);
		expect(result).toMatchObject({ kind: "modern-OK", version: "2026-07-28", discovery: discovery.result });
		const init = fetch.mock.calls[0]?.[1];
		expect(init?.method).toBe("POST");
		expect(init?.headers).toEqual({
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"MCP-Protocol-Version": "2026-07-28",
			"Mcp-Method": "server/discover",
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			jsonrpc: "2.0",
			id: 1,
			method: "server/discover",
			params: {
				_meta: {
					"io.modelcontextprotocol/protocolVersion": "2026-07-28",
					"io.modelcontextprotocol/clientInfo": options.clientInfo,
					"io.modelcontextprotocol/clientCapabilities": options.clientCapabilities,
				},
			},
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retries exactly once with the newest mutual version", async () => {
		const fetch = vi
			.fn(async (_url: URL, _init: RequestInit) => reply(discovery))
			.mockResolvedValueOnce(
				reply(
					rpcError(-32022, "UnsupportedProtocolVersionError", {
						supported: ["2026-01-01", "2026-06-01", "2026-07-28"],
					}),
					400,
				),
			);
		const result = await probeHttpEra(new URL("https://fixture.test"), fetch, options);
		expect(result).toMatchObject({ kind: "modern-version-retry", version: "2026-07-28" });
		expect(fetch).toHaveBeenCalledTimes(2);
		const init = fetch.mock.calls[1]?.[1];
		expect(new Headers(init?.headers).get("MCP-Protocol-Version")).toBe(
			JSON.parse(String(init?.body)).params._meta["io.modelcontextprotocol/protocolVersion"],
		);
	});

	it.each(["", "not JSON", JSON.stringify(rpcError(-32601, "Method not found"))])(
		"falls back on an empty or unrecognized HTTP 400 body: %s",
		async (body) => {
			const fetch = vi.fn(async () => new Response(body, { status: 400 }));
			expect(await probeHttpEra(new URL("https://fixture.test"), fetch, options)).toEqual({
				kind: "legacy-fallback",
			});
			expect(fetch).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["HeaderMismatch", "MissingCapabilityError"])("retains modern classification on %s", async (name) => {
		const error = rpcError(-32000, name);
		const result = await probeHttpEra(new URL("https://fixture.test"), async () => reply(error, 400), options);
		expect(result).toMatchObject({ kind: "modern-OK", error: error.error });
	});

	it.each([401, 403, 404, 429, 500])("surfaces an actionable error on HTTP %s", async (status) => {
		const result = await probeHttpEra(new URL("https://fixture.test"), async () => reply({}, status), options);
		expect(result).toMatchObject({ kind: "indeterminate", reason: "http-status", status });
	});

	it("surfaces network failures rather than selecting legacy", async () => {
		const result = await probeHttpEra(
			new URL("https://fixture.test"),
			async () => {
				throw new TypeError("offline");
			},
			options,
		);
		expect(result).toMatchObject({ kind: "indeterminate", reason: "transport", action: expect.any(String) });
	});

	it("does not downgrade on absent mutual versions or a rejected retry", async () => {
		const fetch = vi.fn(async () =>
			reply(
				rpcError(-32022, "UnsupportedProtocolVersionError", {
					supported: ["2026-06-01"],
				}),
				400,
			),
		);
		expect(await probeHttpEra(new URL("https://fixture.test"), fetch, options)).toMatchObject({
			kind: "indeterminate",
			reason: "version-retry-rejected",
			era: "modern",
		});
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(
			await probeHttpEra(new URL("https://fixture.test"), fetch, {
				...options,
				supportedVersions: ["2026-07-28"],
			}),
		).toMatchObject({ kind: "indeterminate", reason: "no-mutual-version", era: "modern" });
	});

	it("rejects a malformed success instead of assuming legacy", async () => {
		expect(
			await probeHttpEra(new URL("https://fixture.test"), async () => reply({ result: {} }), options),
		).toMatchObject({ kind: "indeterminate", reason: "invalid-discovery" });
	});

	it("consumes a per-request SSE discovery response without a GET stream", async () => {
		const fetch = vi.fn(
			async () =>
				new Response(`event: message\ndata: ${JSON.stringify(discovery)}\n\n`, {
					headers: { "Content-Type": "text/event-stream" },
				}),
		);
		expect(await probeHttpEra(new URL("https://fixture.test"), fetch, options)).toMatchObject({ kind: "modern-OK" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});

describe("stdio era detection", () => {
	it("sends discover with only metadata and recognizes its complete envelope", async () => {
		const send = vi.fn(async (_request: ProbeRequest) => discovery);
		expect(await probeStdioEra(send, options)).toMatchObject({ kind: "modern-OK" });
		expect(send.mock.calls[0]?.[0]).toMatchObject({ method: "server/discover" });
		expect(Object.keys(send.mock.calls[0]?.[0].params ?? {})).toEqual(["_meta"]);
	});

	it.each([-32022, "HeaderMismatch", "MissingCapabilityError"])("recognizes modern error %s", async (value) => {
		const error = rpcError(typeof value === "number" ? value : -32000, String(value));
		expect(await probeStdioEra(async () => error, options)).toMatchObject({ kind: "modern-OK" });
	});

	it.each([rpcError(-32601, "Method not found"), {}, undefined])("falls back for nonmodern replies", async (body) => {
		expect(await probeStdioEra(async () => body, options)).toEqual({ kind: "legacy-fallback" });
	});

	it("falls back for nonmodern transport errors", async () => {
		expect(
			await probeStdioEra(async () => {
				throw new Error("closed");
			}, options),
		).toEqual({ kind: "legacy-fallback" });
	});
});
