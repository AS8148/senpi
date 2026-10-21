import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

const STREAMED_DELTA_TYPES: ReadonlySet<AssistantMessageEvent["type"]> = new Set([
	"text_delta",
	"thinking_delta",
	"toolcall_delta",
]);

/**
 * Records one response's timing as the agent loop streams it, then stamps it on the final message (senpi#3879).
 * Wall-clock fields use `Date.now()` so they line up with `timestamp`; the generation window uses the monotonic
 * clock, like the TPS notice, so a clock jump cannot make it negative.
 */
export function createResponseTimingRecorder() {
	let requestedAt: number | undefined;
	let startedMs: number | undefined;
	let firstDeltaMs: number | undefined;
	let lastDeltaMs: number | undefined;
	let firstTokenAt: number | undefined;
	let lastTokenAt: number | undefined;
	let thinkingStreamed = false;

	// Reasoning counted in usage.output may be hidden or summarised after it finished, so it was generated before the
	// first delta; such a response is timed from its start (the TPS notice's rule, senpi#3393).
	const reasonedBeforeFirstDelta = (message: AssistantMessage): boolean => {
		if ((message.usage?.reasoning ?? 0) > 0) return true;
		if (thinkingStreamed) return false;
		return message.content.some((block) => block.type === "thinking");
	};

	return {
		requested(): void {
			requestedAt = Date.now();
		},
		started(): void {
			startedMs ??= performance.now();
		},
		observe(event: AssistantMessageEvent): void {
			if (!STREAMED_DELTA_TYPES.has(event.type)) return;
			const now = performance.now();
			const at = Date.now();
			if (event.type === "thinking_delta") thinkingStreamed = true;
			firstDeltaMs ??= now;
			firstTokenAt ??= at;
			lastDeltaMs = now;
			lastTokenAt = at;
		},
		/** Stamps the final message. A response whose request was never issued gets no timing. */
		stamp(message: AssistantMessage): void {
			if (requestedAt === undefined) return;
			const windowStart = reasonedBeforeFirstDelta(message) ? startedMs : firstDeltaMs;
			const generationMs =
				windowStart !== undefined && lastDeltaMs !== undefined && lastDeltaMs > windowStart
					? Math.round(lastDeltaMs - windowStart)
					: undefined;
			message.timing = {
				requestedAt,
				...(firstTokenAt === undefined ? {} : { firstTokenAt }),
				...(lastTokenAt === undefined ? {} : { lastTokenAt }),
				endedAt: Math.max(Date.now(), lastTokenAt ?? requestedAt),
				...(generationMs === undefined ? {} : { generationMs }),
			};
		},
	};
}
