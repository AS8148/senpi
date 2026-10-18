// senpi#3566 todo 7: what each reverse-call kind reaches on the server.
import { describe, expect, it } from "vitest";
import { createSessionHostCallHandler, type HostCallTarget } from "../src/core/tool-child-host-calls.ts";
import type { HostCallRequest } from "../src/modes/rpc/tool-child/host-calls-server.ts";

function request(overrides: Partial<HostCallRequest>): HostCallRequest {
	return {
		callId: "c1",
		jobId: "j1",
		kind: "tool",
		name: undefined,
		args: null,
		signal: new AbortController().signal,
		context: undefined,
		...overrides,
	};
}

describe("session host-call handler", () => {
	const unreachable = () => Promise.reject(new Error("not reached"));

	it("refuses a tool call from a job that runs for no tool call", async () => {
		const handler = createSessionHostCallHandler({
			executeNested: unreachable,
			callableToolNames: () => [],
			target: () => undefined,
		});
		await expect(handler(request({ kind: "tool", name: "todo" }))).rejects.toMatchObject({
			code: "host_call_no_caller",
		});
	});

	it("lists the callable tools", async () => {
		const handler = createSessionHostCallHandler({
			executeNested: unreachable,
			callableToolNames: () => ["read", "todo"],
			target: () => undefined,
		});
		expect(await handler(request({ kind: "list_tools" }))).toEqual(["read", "todo"]);
	});

	it("refuses completion and reserved typed when no target is registered, and routes to a registered one", async () => {
		const seen: unknown[] = [];
		const reserved: HostCallTarget = async (call) => {
			seen.push(call);
			return { served: call.name };
		};
		const handler = createSessionHostCallHandler({
			executeNested: unreachable,
			callableToolNames: () => [],
			target: (kind) => (kind === "reserved" ? reserved : undefined),
		});
		await expect(handler(request({ kind: "completion", args: { prompt: "x" } }))).rejects.toMatchObject({
			code: "host_call_unsupported_kind",
		});
		const signal = new AbortController().signal;
		expect(await handler(request({ kind: "reserved", name: "agent", args: { a: 1 }, signal }))).toEqual({
			served: "agent",
		});
		expect(seen).toEqual([{ name: "agent", args: { a: 1 }, signal }]);
	});
});
