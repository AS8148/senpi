import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	boundSummarizationInput,
	shrinkSummarizationInputForOverflowRetry,
} from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";

/**
 * senpi#4079: the summarization bound is shared by core and the builtin compaction. When one turn alone is over the
 * budget, it keeps that turn's request and drops the turn's oldest tool steps, never a call without its result.
 */
const CONTEXT_WINDOW = 8_000;
const STEP_TEXT = "x".repeat(1_200);

function oneLongTurn(steps: number): AgentMessage[] {
	const messages: AgentMessage[] = [{ role: "user", content: "the turn's request", timestamp: 0 }];
	for (let step = 0; step < steps; step++) {
		messages.push({
			role: "assistant",
			content: [
				{ type: "text", text: `step ${step} ${STEP_TEXT}` },
				{ type: "toolCall", id: `call-${step}`, name: "read", arguments: { path: `file-${step}` } },
			],
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: step * 2 + 1,
		});
		messages.push({
			role: "toolResult",
			toolCallId: `call-${step}`,
			toolName: "read",
			content: [{ type: "text", text: `contents ${step}` }],
			isError: false,
			timestamp: step * 2 + 2,
		});
	}
	return messages;
}

function toolCallIds(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) =>
		message.role === "assistant"
			? message.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []))
			: [],
	);
}

function toolResultIds(messages: AgentMessage[]): string[] {
	return messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : []));
}

describe("#4079 the summarization bound inside one long turn", () => {
	it("#given one turn over the budget #when the input is bounded #then the request stays, the oldest tool steps go, and no call loses its result", () => {
		// given
		const turn = oneLongTurn(30);

		// when
		const bounded = boundSummarizationInput(turn, CONTEXT_WINDOW, 100);

		// then
		expect(bounded.length).toBeLessThan(turn.length);
		expect(bounded[0]).toBe(turn[0]);
		expect(toolCallIds(bounded)).toEqual(toolResultIds(bounded));
		expect(bounded.at(-1)).toBe(turn.at(-1));
	});

	it("#given only the request and plain replies remain #when an overflow retry shrinks the input #then the request is kept", () => {
		// given
		const request: AgentMessage = { role: "user", content: "the turn's request", timestamp: 0 };
		const replies = oneLongTurn(2)
			.filter((message) => message.role === "assistant")
			.map((message) => ({
				...message,
				content: message.content.filter((block) => block.type === "text"),
				stopReason: "stop" as const,
			}));

		// when
		const shrunk = shrinkSummarizationInputForOverflowRetry([request, ...replies], CONTEXT_WINDOW, 100);

		// then
		expect(shrunk?.[0]).toBe(request);
		expect(shrunk).toHaveLength(2);
	});
});
