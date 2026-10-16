import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

/**
 * senpi#3471: the work before a provider request starts streaming (transformContext, getApiKey, the
 * stream function itself) used to run before any bound existed, so a hung step left the turn waiting
 * forever on every surface. The start bound (or, without one, the idle bound) now covers it and ends
 * the turn with a typed provider failure.
 */

class AssistantEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
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

const never = <T>(): Promise<T> => new Promise<T>(() => {});

async function settledTurn(
	stream: AsyncIterable<AgentEvent> & { result(): Promise<AgentMessage[]> },
	ceilingMs = 2_000,
): Promise<AgentMessage[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				for await (const _event of stream) {
				}
				return await stream.result();
			})(),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("the turn never ended")), ceilingMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

const identityConverter = (messages: AgentMessage[]): Message[] => messages as unknown as Message[];

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function context(): AgentContext {
	return { systemPrompt: "You are helpful.", messages: [], tools: [] };
}

function assistantOf(messages: AgentMessage[]): AssistantMessage | undefined {
	return messages.find((message): message is AssistantMessage => message.role === "assistant");
}

describe("the start bound covers the work before the provider stream (senpi#3471)", () => {
	it("ends the turn with a typed start-timeout failure when getApiKey never resolves", async () => {
		// given
		let streamCalled = false;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 30,
			timeoutMs: 10_000,
			getApiKey: () => never<string>(),
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, () => {
				streamCalled = true;
				return new AssistantEventStream();
			}),
		);

		// then
		const assistant = assistantOf(messages);
		expect(assistant?.stopReason).toBe("error");
		expect(assistant?.errorMessage).toContain("Provider stream start timed out after 30ms");
		expect(streamCalled).toBe(false);
	});

	it("ends the turn when transformContext never resolves, and aborts the signal it was given", async () => {
		// given
		let transformSignal: AbortSignal | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 30,
			timeoutMs: 10_000,
			transformContext: (_messages, signal) => {
				transformSignal = signal;
				return never<AgentMessage[]>();
			},
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, () => new AssistantEventStream()),
		);

		// then
		expect(assistantOf(messages)?.errorMessage).toContain("Provider stream start timed out after 30ms");
		expect(transformSignal?.aborted).toBe(true);
	});

	it("ends the turn when the stream function itself never returns a stream", async () => {
		// given
		let requestSignal: AbortSignal | undefined;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			streamStartTimeoutMs: 30,
			timeoutMs: 10_000,
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, (_model, _context, options) => {
				requestSignal = options?.signal;
				return never();
			}),
		);

		// then
		expect(assistantOf(messages)?.errorMessage).toContain("Provider stream start timed out after 30ms");
		expect(requestSignal?.aborted).toBe(true);
	});

	it("falls back to the idle bound when no start bound is set", async () => {
		// given
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			timeoutMs: 30,
			getApiKey: () => never<string>(),
		};

		// when
		const messages = await settledTurn(
			agentLoop([userMessage("Hello")], context(), config, undefined, () => new AssistantEventStream()),
		);

		// then
		const assistant = assistantOf(messages);
		expect(assistant?.stopReason).toBe("error");
		expect(assistant?.errorMessage).toBe("Idle timeout waiting for provider stream after 30ms");
	});

	it("ends the turn as aborted when the caller aborts while getApiKey is pending", async () => {
		// given
		const controller = new AbortController();
		const asked = Promise.withResolvers<void>();
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			timeoutMs: 10_000,
			getApiKey: () => {
				asked.resolve();
				return never<string>();
			},
		};
		const stream = agentLoop(
			[userMessage("Hello")],
			context(),
			config,
			controller.signal,
			() => new AssistantEventStream(),
		);
		const turn = settledTurn(stream);

		// when
		await asked.promise;
		controller.abort();

		// then
		expect(assistantOf(await turn)?.stopReason).toBe("aborted");
	});
});
