/**
 * Tool dispatch seam (senpi#3566 todo 2).
 *
 * RED stub: the exported surface exists so the acceptance suite can import it,
 * but every runtime entry point throws `not implemented` until the seam lands.
 */
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ToolRuntimeKind } from "../../cli/tool-runtime.ts";
import type { ExtensionToolContext, ToolDefinition } from "../extensions/types.ts";
import type { BashOperations } from "../tools/bash.ts";

export type ToolPlacement = "server" | "child";

export interface ToolDispatchedInfo {
	readonly toolCallId: string;
	readonly placement: ToolPlacement;
	readonly pid: number;
	readonly generation: number;
}

export type ToolDispatchObserver = (info: ToolDispatchedInfo) => void;

export type ToolDispatchNotify = (event: string, data?: Record<string, unknown>) => void;

export interface ToolDispatchCall {
	readonly definition: ToolDefinition<any, any>;
	readonly toolCallId: string;
	readonly params: unknown;
	readonly signal?: AbortSignal;
	readonly onUpdate?: AgentToolUpdateCallback<any>;
	readonly ctx?: ExtensionToolContext;
}

export interface ToolDispatcherOptions {
	runtime: ToolRuntimeKind;
	notify?: ToolDispatchNotify;
}

export interface ToolDispatcher {
	readonly kind: ToolRuntimeKind;
	run(call: ToolDispatchCall): Promise<AgentToolResult<unknown>>;
	bashOperations(options?: { shellPath?: string }): import("../tools/bash.ts").BashOperations;
	onDispatched(observer: ToolDispatchObserver): () => void;
}

const NOT_IMPLEMENTED = "not implemented: tool dispatcher seam (senpi#3566 todo 2)";

export class InProcessToolDispatcher implements ToolDispatcher {
	readonly kind: ToolRuntimeKind = "in-process";
	run(_call: ToolDispatchCall): Promise<AgentToolResult<unknown>> {
		throw new Error(NOT_IMPLEMENTED);
	}
	bashOperations(_options?: { shellPath?: string }): BashOperations {
		throw new Error(NOT_IMPLEMENTED);
	}
	onDispatched(_observer: ToolDispatchObserver): () => void {
		throw new Error(NOT_IMPLEMENTED);
	}
}

export class ChildToolDispatcher implements ToolDispatcher {
	readonly kind: ToolRuntimeKind = "child";
	run(_call: ToolDispatchCall): Promise<AgentToolResult<unknown>> {
		throw new Error(NOT_IMPLEMENTED);
	}
	bashOperations(_options?: { shellPath?: string }): BashOperations {
		throw new Error(NOT_IMPLEMENTED);
	}
	onDispatched(_observer: ToolDispatchObserver): () => void {
		throw new Error(NOT_IMPLEMENTED);
	}
}

export function createToolDispatcher(_options: ToolDispatcherOptions): ToolDispatcher {
	throw new Error(NOT_IMPLEMENTED);
}

export function unavailableBashOperations(): BashOperations {
	throw new Error(NOT_IMPLEMENTED);
}
