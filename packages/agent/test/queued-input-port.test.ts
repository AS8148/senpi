import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { Agent, type AgentMessage, type StreamFn } from "../src/index.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function user(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function texts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		return [message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
	});
}

function recordingStream(log: string[], onRequest?: () => void): StreamFn {
	return (_model, context) => {
		log.push(`request:${texts(context.messages).join("|")}`);
		onRequest?.();
		const stream = new MockAssistantStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant("done") }));
		return stream;
	};
}

describe("Agent queuedInputPort (senpi#3549)", () => {
	it("commits a follow-up's consumption before the provider request that carries it", async () => {
		const log: string[] = [];
		const agent = new Agent({
			streamFn: recordingStream(log),
			queuedInputPort: {
				commitConsumption: async (queue, messages) => {
					log.push(`commit:${queue}:${texts(messages).join("|")}`);
				},
			},
		});
		agent.followUp(user("later"));

		await agent.prompt("first");

		expect(log).toEqual(["request:first", "commit:followUp:later", "request:first|later"]);
	});

	it("reports a steering drain as the steering queue", async () => {
		const log: string[] = [];
		let agent: Agent | undefined;
		agent = new Agent({
			streamFn: recordingStream(log, () => {
				if (log.length === 1) agent?.steer(user("steer"));
			}),
			queuedInputPort: {
				commitConsumption: async (queue, messages) => {
					log.push(`commit:${queue}:${texts(messages).join("|")}`);
				},
			},
		});

		await agent.prompt("first");

		expect(log).toEqual(["request:first", "commit:steering:steer", "request:first|steer"]);
	});

	it("keeps a message out of every request and back in its queue when the commit rejects", async () => {
		const log: string[] = [];
		const agent = new Agent({
			streamFn: recordingStream(log),
			queuedInputPort: {
				commitConsumption: async () => {
					throw new Error("journal unavailable");
				},
			},
		});
		agent.followUp(user("later"));

		await agent.prompt("first").catch(() => undefined);

		expect(log).toEqual(["request:first"]);
		expect(texts(agent.state.messages)).toEqual(["first"]);
		expect(texts(agent.peekQueuedMessages())).toEqual(["later"]);
	});

	it("leaves the standalone queue behavior unchanged without a port", async () => {
		const log: string[] = [];
		const agent = new Agent({ streamFn: recordingStream(log) });
		agent.followUp(user("later"));

		await agent.prompt("first");

		expect(log).toEqual(["request:first", "request:first|later"]);
	});
});
