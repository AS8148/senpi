import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	InitializeResultSchema,
	type JSONRPCMessage,
	LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import type { DiscoveryResult } from "./era.ts";
import { ModernTransportError } from "./transport.ts";

/** Local SDK lifecycle dialect; the negotiated wire version belongs only to the underlying transport. */
export class ModernSdkBridge implements Transport {
	onmessage?: Transport["onmessage"];
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];
	readonly #transport: Transport;
	readonly #initializeResult;
	#initialized = false;

	constructor(transport: Transport, discovery: DiscoveryResult, wireVersion: string) {
		if (!discovery.supportedVersions.includes(wireVersion)) {
			throw new ModernTransportError(`Discovery does not support negotiated MCP version ${wireVersion}`);
		}
		this.#transport = transport;
		this.#initializeResult = InitializeResultSchema.parse({
			protocolVersion: LATEST_PROTOCOL_VERSION,
			capabilities: discovery.capabilities,
			serverInfo: discovery._meta["io.modelcontextprotocol/serverInfo"],
			...(discovery.instructions === undefined ? {} : { instructions: discovery.instructions }),
		});
	}

	async start(): Promise<void> {
		this.#transport.onmessage = (message, extra) => {
			if ("result" in message && message.result.nextCursor === null) delete message.result.nextCursor;
			this.onmessage?.(message, extra);
		};
		this.#transport.onclose = () => this.onclose?.();
		this.#transport.onerror = (error) => this.onerror?.(error);
		await this.#transport.start();
	}

	async send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void> {
		if ("method" in message && message.method === "initialize") {
			if (!("id" in message) || this.#initialized) {
				throw new ModernTransportError("Modern MCP bridge has already initialized");
			}
			this.#initialized = true;
			this.onmessage?.({ jsonrpc: "2.0", id: message.id, result: this.#initializeResult });
			return;
		}
		if ("method" in message && message.method === "notifications/initialized" && !("id" in message)) return;
		await this.#transport.send(message, options);
	}

	close(): Promise<void> {
		return this.#transport.close();
	}
}
