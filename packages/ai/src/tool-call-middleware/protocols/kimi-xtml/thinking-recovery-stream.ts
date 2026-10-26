import type { AssistantMessageEventStream } from "../../../types.ts";
import { assistantEvents, carryAssistantCapture, pushAssistantProgress } from "../../../utils/assistant-capture.ts";
import { AssistantMessageEventStream as AssistantMessageEventStreamImpl } from "../../../utils/event-stream.ts";
import { recoverKimiXtmlThinking } from "./thinking-recovery.ts";

export function wrapStreamWithKimiThinkingRecovery(
	innerStream: AssistantMessageEventStream,
): AssistantMessageEventStream {
	const outerStream = new AssistantMessageEventStreamImpl();

	void (async (): Promise<void> => {
		try {
			// Every record but the terminal crosses unchanged: same event objects, same indices, controls in order.
			for await (const event of assistantEvents(innerStream, (progress) =>
				pushAssistantProgress(outerStream, progress),
			)) {
				if (event.type === "done") {
					const message = recoverKimiXtmlThinking(event.message);
					outerStream.push(carryAssistantCapture(event, { type: "done", reason: event.reason, message }, message));
					outerStream.end();
					return;
				}
				if (event.type === "error") {
					outerStream.push(event);
					outerStream.end();
					return;
				}
				outerStream.push(event);
			}
			outerStream.end(recoverKimiXtmlThinking(await innerStream.result()));
		} catch (error) {
			outerStream.fail(error);
		}
	})();

	return outerStream;
}
