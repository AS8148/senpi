import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ConnectError } from "../errors.ts";
import type { McpLogger } from "../log.ts";
import { type ProbeOptions, probeStdioEra } from "./era.ts";
import { EraCache } from "./era-cache.ts";
import { ModernTransportError } from "./transport.ts";

/** Probe the actual SDK child before initialize; never spawn a second process to choose its era. */
export function probeStdioTransport(
	transport: Transport,
	options: ProbeOptions,
	logger: McpLogger,
	timeoutMs: number,
	serverName: string,
): void {
	const start = transport.start.bind(transport);
	const close = transport.close.bind(transport);
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
			const message =
				"modern stdio server detected; stdio modern transport not yet supported - configure an HTTP endpoint";
			logger.error(message);
			throw new ConnectError(message, { phase: "modern-stdio", serverName });
		}
	};
}
