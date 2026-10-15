import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQueryInput,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import {
	HOST_TOOL_DENIAL_HOOKS,
	TOOL_EXECUTION_DENIED_MESSAGE,
} from "../../../src/core/extensions/builtin/anthropic-subscription/tools.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const sdk = (value: unknown): SDKMessage => value as SDKMessage;

/** What Claude Code turns every PreToolUse deny into: it prefixes "PreToolUse:<Tool> hook error:" itself. */
const claudeCodeDenial = `PreToolUse:Bash hook error: ${TOOL_EXECUTION_DENIED_MESSAGE}`;

function deniedBashTurn(): SDKMessage[] {
	return [
		sdk({
			type: "stream_event",
			event: { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
		}),
		sdk({
			type: "stream_event",
			event: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_bash", name: "Bash", input: {} },
			},
		}),
		sdk({
			type: "stream_event",
			event: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "ls" }) },
			},
		}),
		sdk({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
		sdk({
			type: "stream_event",
			event: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } },
		}),
		sdk({
			type: "user",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "toolu_bash", is_error: true, content: claudeCodeDenial }],
			},
		}),
		sdk({ type: "result", subtype: "success", is_error: false, stop_reason: "tool_use", result: "" }),
	];
}

afterEach(() => resetSdkBoundary());

describe("#3417: the host tool handoff never reads or shows as an error", () => {
	it("tells the model the handoff is expected and never to mention it to the user", () => {
		expect(HOST_TOOL_DENIAL_HOOKS.PreToolUse?.[0]?.hooks?.length).toBe(1);
		expect(TOOL_EXECUTION_DENIED_MESSAGE).toMatch(/^Not an error\b/);
		expect(TOOL_EXECUTION_DENIED_MESSAGE).toMatch(/do not mention/i);
	});

	it("keeps Claude Code's denial out of senpi's message: one host tool call, no error, no hook text", async () => {
		overrideSdkBoundary({
			query: (_input: SdkQueryInput) => ({
				async *[Symbol.asyncIterator]() {
					yield* deniedBashTurn();
				},
				async interrupt() {},
				close() {},
			}),
		});

		const message = await streamAnthropicSubscription(model, { messages: [], tools: [] }).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.errorMessage).toBeUndefined();
		expect(message.content.filter((block) => block.type === "toolCall")).toHaveLength(1);
		expect(JSON.stringify(message.content)).not.toContain("hook error");
	});
});
