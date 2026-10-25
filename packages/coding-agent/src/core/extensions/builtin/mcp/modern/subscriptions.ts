import { randomUUID } from "node:crypto";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { DiscoveryResult } from "./era.ts";
import { isRecord } from "./form-schema.ts";

const subscriptionKey = "io.modelcontextprotocol/subscriptionId";
const listFilters = {
	"notifications/tools/list_changed": "toolsListChanged",
	"notifications/prompts/list_changed": "promptsListChanged",
	"notifications/resources/list_changed": "resourcesListChanged",
} as const;
type Filter = {
	toolsListChanged?: boolean;
	promptsListChanged?: boolean;
	resourcesListChanged?: boolean;
	resourceSubscriptions?: string[];
};

/** Connection-owned streams bypass the SDK's finite request timeout and MRTR consent lifecycle. */
export class ModernSubscriptions {
	readonly #send: Transport["send"];
	readonly #capabilities: DiscoveryResult["capabilities"];
	readonly #sendCompletesStream: boolean;
	readonly #filter: Filter = {};
	readonly #resourceLists = new Set<string | number>();
	#resources: string[] = [];
	#active?: { id: string; requested: Filter; accepted?: Filter };
	#timer?: ReturnType<typeof setTimeout>;
	#retry = 0;
	#closed = false;
	#started = false;

	constructor(send: Transport["send"], capabilities: DiscoveryResult["capabilities"], sendCompletesStream = false) {
		this.#send = send;
		this.#capabilities = capabilities;
		this.#sendCompletesStream = sendCompletesStream;
	}

	outgoing(message: JSONRPCMessage): void {
		if (!("method" in message)) return;
		if (message.method === "notifications/cancelled") {
			const id = message.params?.requestId;
			if (typeof id === "string" || typeof id === "number") this.#resourceLists.delete(id);
		}
		if (!("id" in message)) return;
		if (message.method === "resources/list" && this.#supports("resources", "subscribe")) {
			if (message.params?.cursor === undefined) this.#resources = [];
			this.#resourceLists.add(message.id);
		}
		if (this.#started || !["tools/list", "prompts/list", "resources/list"].includes(message.method)) return;
		this.#started = true;
		// The builtin catalog uses all three lists. Never opt in to an undeclared feature.
		if (this.#supports("tools", "listChanged")) this.#filter.toolsListChanged = true;
		if (this.#supports("prompts", "listChanged")) this.#filter.promptsListChanged = true;
		if (this.#supports("resources", "listChanged")) this.#filter.resourcesListChanged = true;
		this.#open();
	}

	/** Returns true only for application messages that may reach the existing SDK notification handlers. */
	incoming(message: JSONRPCMessage): boolean {
		if (
			"id" in message &&
			message.id !== undefined &&
			this.#resourceLists.delete(message.id) &&
			"result" in message
		) {
			const resources = message.result.resources;
			if (Array.isArray(resources)) {
				for (const resource of resources)
					if (isRecord(resource) && typeof resource.uri === "string") this.#resources.push(resource.uri);
				if (!message.result.nextCursor) {
					const uris = [...new Set(this.#resources)].sort();
					if (JSON.stringify(uris) !== JSON.stringify(this.#filter.resourceSubscriptions ?? [])) {
						this.#filter.resourceSubscriptions = uris;
						this.#cancel();
						this.#open();
					}
				}
			}
		}
		const active = this.#active;
		if (active && "id" in message && message.id === active.id) {
			if ("result" in message && message.result._meta?.[subscriptionKey] !== active.id) {
				this.#failed(active);
				return false;
			}
			// A response ends the long-lived request; graceful server shutdown is not a retry trigger.
			this.#active = undefined;
			return false;
		}
		if (!("method" in message)) return true;
		if (message.method === "notifications/cancelled" && message.params?.requestId === active?.id) {
			this.#active = undefined;
			return false;
		}
		const meta = message.params?._meta;
		const id = isRecord(meta) ? meta[subscriptionKey] : undefined;
		const acknowledged = message.method === "notifications/subscriptions/acknowledged";
		const list = Object.hasOwn(listFilters, message.method);
		const resource = message.method === "notifications/resources/updated";
		if (!acknowledged && !list && !resource) return true;
		if (!active || id !== active.id) return false;
		if (acknowledged) {
			if (active.accepted || !isRecord(message.params?.notifications)) return false;
			const offered = message.params.notifications;
			const accepted: Filter = {};
			for (const key of Object.values(listFilters))
				if (active.requested[key] && offered[key] === true) accepted[key] = true;
			const uris = offered.resourceSubscriptions;
			if (Array.isArray(uris))
				accepted.resourceSubscriptions = active.requested.resourceSubscriptions?.filter((uri) =>
					uris.includes(uri),
				);
			active.accepted = accepted;
			this.#retry = 0;
			return false;
		}
		if (!active.accepted) return false;
		if (resource) return (active.accepted.resourceSubscriptions?.length ?? 0) > 0;
		return active.accepted[listFilters[message.method as keyof typeof listFilters]] === true;
	}

	failedSend(message: JSONRPCMessage): void {
		if ("id" in message && message.id !== undefined) this.#resourceLists.delete(message.id);
	}

	dispose(): void {
		this.#closed = true;
		this.#cancel();
		this.#resourceLists.clear();
		this.#resources = [];
	}

	#supports(feature: string, flag: string): boolean {
		const capability = this.#capabilities[feature];
		return isRecord(capability) && capability[flag] === true;
	}

	#cancel(): void {
		if (this.#timer) clearTimeout(this.#timer);
		this.#timer = undefined;
		const active = this.#active;
		this.#active = undefined;
		if (active)
			void this.#send({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { requestId: active.id },
			}).catch(() => {});
	}

	#open(): void {
		if (
			this.#closed ||
			this.#active ||
			(!Object.values(this.#filter).some((value) => value === true) && !this.#filter.resourceSubscriptions?.length)
		)
			return;
		const active = { id: `senpi-subscription-${randomUUID()}`, requested: structuredClone(this.#filter) };
		this.#active = active;
		// HTTP send remains pending for the entire SSE lifetime. No caller awaits it.
		void this.#send({
			jsonrpc: "2.0",
			id: active.id,
			method: "subscriptions/listen",
			params: { notifications: active.requested },
		}).then(
			() => {
				if (this.#sendCompletesStream) this.#failed(active);
			},
			() => this.#failed(active),
		);
	}

	#failed(active: { id: string }): void {
		if (this.#closed || this.#active !== active) return;
		this.#active = undefined;
		this.#timer = setTimeout(
			() => {
				this.#timer = undefined;
				this.#open();
			},
			Math.min(30_000, 1000 * 2 ** Math.min(this.#retry++, 5)),
		);
		this.#timer.unref?.();
	}
}
