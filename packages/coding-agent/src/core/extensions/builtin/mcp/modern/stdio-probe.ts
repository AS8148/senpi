import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConnectError } from "../errors.ts";
import type { McpLogger } from "../log.ts";
import { type DiscoveryResult, type ProbeOptions, probeStdioEra } from "./era.ts";
import { EraCache } from "./era-cache.ts";
import { modernInitializeResult, normalizeModernResult } from "./sdk-bridge.ts";
import { ModernTransportError } from "./transport.ts";
import { modernizeRequest } from "./wire.ts";

/**
 * Probe the actual SDK child before initialize; never spawn a second process to choose its era.
 * A modern child keeps the same process: `initialize` is answered locally from discovery and every
 * later request carries the per-request `_meta` at the negotiated version.
 */
export function probeStdioTransport(
	transport: Transport,
	options: ProbeOptions,
	logger: McpLogger,
	timeoutMs: number,
	serverName: string,
	onModern?: (version: string) => void,
): void {
	const start = transport.start.bind(transport);
	const close = transport.close.bind(transport);
	const send = transport.send.bind(transport);
	const abort = new AbortController();
	const cache = new EraCache();
	transport.close = async () => {
		abort.abort();
		await close();
	};
	transport.start = async () => {
		await start();
		const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)]);
		const outcome = await cache.resolve({ kind: "stdio", process: transport }, () =>
			probeStdioEra(async (request) => {
				const reply = Promise.withResolvers<unknown>();
				const onmessage = transport.onmessage;
				const onclose = transport.onclose;
				const onerror = transport.onerror;
				const onabort = () => reply.reject(signal.reason);
				signal.addEventListener("abort", onabort, { once: true });
				transport.onmessage = (message, extra) => {
					if ("id" in message && !("method" in message) && message.id === request.id) reply.resolve(message);
					else onmessage?.(message, extra);
				};
				transport.onclose = () => {
					reply.reject(new ModernTransportError("MCP stdio closed during discovery"));
					onclose?.();
				};
				transport.onerror = (error) => {
					reply.reject(error);
					onerror?.(error);
				};
				try {
					signal.throwIfAborted();
					void transport.send(request).catch(reply.reject);
					return await reply.promise;
				} finally {
					signal.removeEventListener("abort", onabort);
					transport.onmessage = onmessage;
					transport.onclose = onclose;
					transport.onerror = onerror;
				}
			}, options),
		);
		signal.throwIfAborted();
		if (outcome.kind === "modern-OK" || outcome.kind === "modern-version-retry") {
			if (!outcome.discovery) {
				const message = `MCP server ${serverName} modern discovery failed: ${outcome.error?.message}`;
				logger.error(message);
				throw new ConnectError(message, { phase: "modern-stdio", serverName });
			}
			speakModern(outcome.discovery, outcome.version);
			onModern?.(outcome.version);
		}
	};

	function speakModern(discovery: DiscoveryResult, version: string): void {
		const initializeResult = modernInitializeResult(discovery, version);
		const deliver = transport.onmessage;
		let initialized = false;
		transport.onmessage = (message, extra) => deliver?.(normalizeModernResult(message), extra);
		transport.send = async (message, sendOptions) => {
			if (!("method" in message)) return send(message, sendOptions);
			if (message.method === "initialize") {
				if (!("id" in message) || initialized) {
					throw new ModernTransportError("Modern MCP stdio has already initialized");
				}
				initialized = true;
				transport.onmessage?.({ jsonrpc: "2.0", id: message.id, result: initializeResult });
				return;
			}
			if (message.method === "notifications/initialized" && !("id" in message)) return;
			const request = modernizeRequest(
				"id" in message ? message.id : 0,
				message.method,
				options.clientInfo,
				options.clientCapabilities,
				version,
				message.params,
			);
			if ("id" in message) return send(request, sendOptions);
			const { id: _id, ...notification } = request;
			return send(notification, sendOptions);
		};
	}
}
