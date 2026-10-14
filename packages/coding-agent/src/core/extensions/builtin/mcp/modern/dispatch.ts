import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { configureMcpElicitation, MCP_CLIENT_ELICITATION_CAPABILITY } from "../elicitation.ts";
import { ConnectError } from "../errors.ts";
import { loadMcpSdkClient } from "../sdk.lazy.ts";
import {
	type MaterializeMcpTransportOptions,
	type McpMaterializedTransport,
	materializeMcpTransport,
} from "../transport-sdk.ts";
import { type EraOutcome, probeHttpEra } from "./era.ts";
import { EraCache } from "./era-cache.ts";
import { modernHttpFetch } from "./http-fetch.ts";
import { ModernSdkBridge } from "./sdk-bridge.ts";
import { probeStdioTransport } from "./stdio-probe.ts";
import { ModernHttpTransport } from "./transport.ts";
import { MODERN_PROTOCOL_VERSION } from "./wire.ts";

const clientInfo = { name: "senpi-mcp-client", version: "0.0.0" };
const probeOptions = {
	clientInfo,
	clientCapabilities: MCP_CLIENT_ELICITATION_CAPABILITY,
	supportedVersions: [MODERN_PROTOCOL_VERSION],
};

export async function materializeNegotiatedTransport(
	options: MaterializeMcpTransportOptions,
	serverName: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<McpMaterializedTransport> {
	signal.throwIfAborted();
	const { spec, logger } = options;
	let outcome: EraOutcome = { kind: "legacy-fallback" };
	const cache = new EraCache();
	if (spec.kind === "http") {
		const fetch = modernHttpFetch(spec, signal);
		const timeout = AbortSignal.timeout(timeoutMs);
		outcome = await cache.resolve({ kind: "http", url: spec.url }, () =>
			probeHttpEra(
				spec.url,
				(url, init) =>
					fetch(url, {
						...init,
						signal: timeout,
					}),
				probeOptions,
			),
		);
		signal.throwIfAborted();
		timeout.throwIfAborted();
		if (outcome.kind === "modern-OK" || outcome.kind === "modern-version-retry") {
			if (!outcome.discovery) {
				throw new ConnectError(`MCP server ${serverName} modern discovery failed: ${outcome.error?.message}`, {
					phase: "connect",
					serverName,
				});
			}
			const { Client } = await loadMcpSdkClient();
			const client = new Client(clientInfo, { capabilities: MCP_CLIENT_ELICITATION_CAPABILITY });
			await configureMcpElicitation(client, options.elicitationUiProvider);
			const transport = new ModernSdkBridge(
				new ModernHttpTransport({
					url: spec.url,
					fetch,
					clientInfo,
					clientCapabilities: MCP_CLIENT_ELICITATION_CAPABILITY,
					protocolVersion: outcome.version,
				}),
				outcome.discovery,
				outcome.version,
			);
			logVersion(transport, outcome.version);
			return {
				client,
				transport,
				readPid: () => null,
				close: async () => {
					await transport.close();
					await client.close();
				},
			};
		}
		if (outcome.kind === "indeterminate" && (outcome.era === "modern" || outcome.reason === "invalid-discovery")) {
			throw new ConnectError(`MCP server ${serverName}: ${outcome.reason}. ${outcome.action}`, {
				phase: "connect",
				serverName,
				cause: outcome.cause,
			});
		}
	}
	// Unknown endpoints (including legacy session-required 404s and auth challenges) retain SDK diagnostics.
	const legacy = await materializeMcpTransport(options);
	if (spec.kind === "stdio") probeStdioTransport(legacy.transport, probeOptions, logger, timeoutMs, serverName);
	logVersion(legacy.transport);
	return legacy;

	function logVersion(transport: Transport, modernVersion?: string): void {
		const setVersion = transport.setProtocolVersion?.bind(transport);
		transport.setProtocolVersion = (sdkVersion) => {
			setVersion?.(sdkVersion);
			logger.info(
				`MCP server ${serverName} negotiated: era=${modernVersion ? "modern" : "legacy"} version=${modernVersion ?? sdkVersion}`,
			);
		};
	}
}
