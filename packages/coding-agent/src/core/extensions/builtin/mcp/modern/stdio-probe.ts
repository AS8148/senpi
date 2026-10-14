import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConnectError } from "../errors.ts";
import type { McpLogger } from "../log.ts";
import { reapProcessTree } from "../process-tree.ts";
import { type DiscoveryResult, type ProbeOptions, type ProbeRequest, probeStdioEra } from "./era.ts";
import { modernInitializeResult, normalizeModernResult } from "./sdk-bridge.ts";
import { ModernTransportError } from "./transport.ts";
import { modernizeRequest } from "./wire.ts";

/** How long a stdio child gets to answer discovery (at most a quarter of the connect timeout) before it is treated as legacy. */
export const STDIO_PROBE_MS = 2_000;

/**
 * Probe the SDK's own child before initialize. A modern child keeps its process: `initialize` is answered
 * locally from discovery and every later request carries the per-request `_meta` at the negotiated version.
 * A clean non-modern error keeps the process for the legacy handshake. Anything unclean (silence, junk on
 * stdout, an exit) restarts the child, so the legacy handshake meets a fresh process exactly as before.
 */
export function probeStdioTransport(
	transport: Transport,
	options: ProbeOptions,
	logger: McpLogger,
	timeoutMs: number,
	serverName: string,
	onModern?: (version: string) => void,
	probeMs = STDIO_PROBE_MS,
): void {
	const start = transport.start.bind(transport);
	const close = transport.close.bind(transport);
	const send = transport.send.bind(transport);
	const abort = new AbortController();
	transport.close = async () => {
		abort.abort();
		await close();
	};
	transport.start = async () => {
		await start();
		const outcome = await probeStdioEra(exchange, options);
		abort.signal.throwIfAborted();
		if (outcome.kind === "legacy-fallback") {
			if (outcome.restart) await restart();
			return;
		}
		if (outcome.kind === "indeterminate" || !outcome.discovery) {
			const reason = outcome.kind === "indeterminate" ? outcome.reason : outcome.error?.message;
			const message = `MCP server ${serverName} modern discovery failed: ${reason}`;
			logger.error(message);
			throw new ConnectError(message, { phase: "modern-stdio", serverName });
		}
		speakModern(outcome.discovery, outcome.version);
		onModern?.(outcome.version);
	};

	/** One discovery exchange, bounded; never reaches the SDK's handlers. */
	async function exchange(request: ProbeRequest): Promise<unknown> {
		const reply = Promise.withResolvers<unknown>();
		const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(probeMs, Math.floor(timeoutMs / 4)))]);
		const onabort = () => reply.reject(signal.reason);
		const { onmessage, onclose, onerror } = transport;
		signal.addEventListener("abort", onabort, { once: true });
		transport.onmessage = (message, extra) => {
			if ("id" in message && !("method" in message) && message.id === request.id) reply.resolve(message);
			else onmessage?.(message, extra);
		};
		transport.onclose = () => reply.reject(new ModernTransportError("MCP stdio closed during discovery"));
		transport.onerror = (error) => reply.reject(error);
		try {
			signal.throwIfAborted();
			void send(request).catch(reply.reject);
			return await reply.promise;
		} finally {
			signal.removeEventListener("abort", onabort);
			transport.onmessage = onmessage;
			transport.onclose = onclose;
			transport.onerror = onerror;
		}
	}

	async function restart(): Promise<void> {
		logger.info(`MCP server ${serverName}: no clean discovery answer; restarting it for the legacy handshake`);
		// The old child's close event is not the connection closing; swallow exactly that one event.
		const pid = (transport as { readonly pid?: number | null }).pid;
		let stale = pid == null ? 0 : 1;
		const onclose = transport.onclose;
		transport.onclose = () => {
			if (stale > 0) stale--;
			else onclose?.();
		};
		// Kill the probed tree outright: a silent child may ignore the SDK's graceful stdin-close for seconds.
		if (pid != null) await reapProcessTree(pid, { termWaitMs: 200, killWaitMs: 200 });
		await close();
		abort.signal.throwIfAborted();
		await start();
	}

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
