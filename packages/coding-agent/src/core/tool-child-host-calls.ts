/**
 * What a session's tool child can reach on the server (senpi#3566 todo 7, DESIGN PART 1): a call from a child-run tool
 * body. A `tool` call runs as a nested call of the tool call that owns the job - the same path as in-process
 * `ctx.executeTool`, hooks once - and `list_tools` names the tools such a call may reach.
 */
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { HostCallHandler } from "../modes/rpc/tool-child/host-calls-server.ts";

export interface SessionHostCallDeps {
	/** Runs `name` as a nested call of `parentToolCallId` through the session's tool pipeline. */
	readonly executeNested: (
		parentToolCallId: string,
		name: string,
		args: unknown,
		signal: AbortSignal,
	) => Promise<AgentToolCallOutcome>;
	readonly callableToolNames: () => readonly string[];
}

export class HostCallError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "HostCallError";
		this.code = code;
	}
}

export function createSessionHostCallHandler(deps: SessionHostCallDeps): HostCallHandler {
	return async (request) => {
		switch (request.kind) {
			case "tool": {
				const parent = callingToolCallId(request.context);
				if (parent === undefined) throw new HostCallError("host_call_no_caller", "the job runs for no tool call");
				if (request.name === undefined) throw new HostCallError("host_call_no_name", "a tool call names no tool");
				const outcome = await deps.executeNested(parent, request.name, request.args, request.signal);
				return { result: outcome.result, isError: outcome.isError };
			}
			case "list_tools":
				return [...deps.callableToolNames()];
			case "completion":
			case "reserved":
				throw new HostCallError("host_call_unsupported_kind", `${request.kind} calls are not served yet`);
		}
	};
}

function callingToolCallId(context: unknown): string | undefined {
	if (typeof context !== "object" || context === null) return undefined;
	const toolCallId: unknown = Reflect.get(context, "toolCallId");
	return typeof toolCallId === "string" ? toolCallId : undefined;
}
