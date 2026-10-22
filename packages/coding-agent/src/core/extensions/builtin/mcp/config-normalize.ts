import type { McpServerConfig, RawConfig } from "./config-schema.ts";
import { MCP_STARTUP_RACE_MS } from "./startup-race.ts";

export function normalizeServer(server: NonNullable<RawConfig["mcpServers"]>[string]): McpServerConfig {
	const type = server.type ?? (server.url ? "http" : "stdio");
	return {
		args: server.args ?? [],
		connectTimeoutMs: server.connectTimeoutMs ?? 15_000,
		enabled: server.enabled ?? true,
		exposure: server.exposure ?? "auto",
		idleTimeoutMin: server.idleTimeoutMin ?? 10,
		lifecycle: server.lifecycle ?? "lazy",
		logLevel: server.logLevel ?? "info",
		requestTimeoutMs: server.requestTimeoutMs ?? 30_000,
		startupTimeoutMs: server.startupTimeoutMs ?? MCP_STARTUP_RACE_MS,
		type,
		...server,
	};
}
