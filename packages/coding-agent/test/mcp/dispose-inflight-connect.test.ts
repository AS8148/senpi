import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import type { McpConnectionEntry } from "../../src/core/extensions/builtin/mcp/service-types.ts";
import { connectAndRefreshMcpCatalog } from "../../src/core/extensions/builtin/mcp/startup-race.ts";
import type { McpTransportConnection } from "../../src/core/extensions/builtin/mcp/transport.ts";

const transportControl = vi.hoisted(() => ({
	rejectConnect: undefined as ((error: Error) => void) | undefined,
}));

vi.mock("../../src/core/extensions/builtin/mcp/transport.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/extensions/builtin/mcp/transport.ts")>();
	return {
		...actual,
		createMcpTransport: (options: { serverName: string }): Partial<McpTransportConnection> => ({
			serverName: options.serverName,
			transportKind: "stdio",
			connectTimeoutMs: 60_000,
			transport: {} as McpTransportConnection["transport"],
			materialize: async () => undefined,
			getRootPid: () => null,
			closeTransport: async () => undefined,
		}),
		// The handshake settles only when the test says so: a transport whose close lands after shutdown returned.
		connectMcpTransport: () =>
			new Promise<void>((_, reject) => {
				transportControl.rejectConnect = reject;
			}),
		shutdownMcpTransport: async () => undefined,
	};
});

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
	transportControl.rejectConnect = undefined;
	for (const cleanup of cleanupTasks.splice(0).reverse()) await cleanup();
});

function serverConfig(): McpServerConfig {
	return {
		args: [],
		command: "never-ready",
		connectTimeoutMs: 60_000,
		enabled: true,
		exposure: "auto",
		idleTimeoutMin: 10,
		lifecycle: "eager",
		logLevel: "info",
		requestTimeoutMs: 30_000,
		startupTimeoutMs: 250,
		type: "stdio",
	};
}

function readLog(file: string): string | undefined {
	return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

describe("ServerConnection dispose with a connect in flight (senpi#4013)", () => {
	it("#given a connect whose transport closes only after dispose returned #when that attempt then fails #then nothing is logged and the disposed connection stays disabled", async () => {
		// given
		const logDir = await mkdtemp(join(tmpdir(), "senpi-mcp-4013-"));
		cleanupTasks.push(() => rm(logDir, { recursive: true, force: true }));
		const logger = createMcpLogger("never-ready", { logDir });
		const config = serverConfig();
		const connection = new ServerConnection({ serverName: "never-ready", config, logger });
		const entry: McpConnectionEntry = {
			key: "never-ready\0hash",
			name: "never-ready",
			configHash: "hash",
			connection,
			logger,
			createdAtMs: Date.now(),
			counters: { callCount: 0, errorCount: 0, totalLatencyMs: 0, reconnectCount: 0 },
			cacheRefreshedAfterConnect: false,
		};
		const attempt = connectAndRefreshMcpCatalog(entry, config);
		await vi.waitFor(() => expect(transportControl.rejectConnect).toBeDefined());
		expect(connection.state).toBe("connecting");

		// when: dispose returns, then the aborted handshake fails late
		await connection.dispose();
		const atDispose = readLog(logger.filePath);
		transportControl.rejectConnect?.(new Error("transport closed"));
		await attempt;

		// then
		expect(readLog(logger.filePath)).toBe(atDispose);
		expect(connection.state).toBe("disabled");
	});
});
