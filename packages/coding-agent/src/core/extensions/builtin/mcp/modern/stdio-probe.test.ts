import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { McpLogger } from "../log.ts";
import { probeStdioTransport } from "./stdio-probe.ts";
import { MODERN_PROTOCOL_VERSION } from "./wire.ts";

const options = {
	clientInfo: { name: "test", version: "1" },
	clientCapabilities: {},
	supportedVersions: [MODERN_PROTOCOL_VERSION],
};
function logger(): McpLogger {
	return {
		filePath: "",
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		stderr: vi.fn(),
		log: vi.fn(),
		getRingBuffer: () => [],
	};
}

describe("stdio discovery ownership", () => {
	it("probes and initializes the same started legacy transport without changing initialize bytes", async () => {
		const sent: JSONRPCMessage[] = [];
		const inner: Transport = {
			start: vi.fn(async () => {}),
			close: async () => inner.onclose?.(),
			send: async (message) => {
				sent.push(message);
				if (!("method" in message) || !("id" in message)) return;
				if (message.method === "server/discover") {
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "Method not found" },
					});
				} else if (message.method === "initialize") {
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: message.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "legacy", version: "1" },
						},
					});
				} else {
					inner.onmessage?.({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
				}
			},
		};
		const start = inner.start;
		probeStdioTransport(inner, options, logger(), 2000, "fixture");
		const client = new Client(options.clientInfo, { capabilities: options.clientCapabilities });
		try {
			await client.connect(inner);
			expect((await client.listTools()).tools).toEqual([]);
			expect(start).toHaveBeenCalledTimes(1);
			expect(sent.map((message) => ("method" in message ? message.method : ""))).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/list",
			]);
			expect(sent[1]).toMatchObject({ id: 0, params: { capabilities: {}, clientInfo: options.clientInfo } });
			expect(sent[1]).not.toHaveProperty("params._meta");
		} finally {
			await client.close();
		}
	});

	it("rejects modern stdio explicitly without sending initialize or restarting", async () => {
		const sent: JSONRPCMessage[] = [];
		const log = logger();
		const inner: Transport = {
			start: vi.fn(async () => {}),
			close: vi.fn(async () => inner.onclose?.()),
			send: async (message) => {
				sent.push(message);
				if ("id" in message)
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32020, message: "Modern" },
					});
			},
		};
		const start = inner.start;
		const close = inner.close;
		probeStdioTransport(inner, options, log, 2000, "fixture");
		const client = new Client(options.clientInfo);
		try {
			await expect(client.connect(inner)).rejects.toThrow(
				/modern stdio server detected.*configure an HTTP endpoint/,
			);
			expect(start).toHaveBeenCalledTimes(1);
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({ method: "server/discover" });
			expect(log.error).toHaveBeenCalledOnce();
		} finally {
			await client.close();
		}
		expect(close).toHaveBeenCalledOnce();
	});
});
