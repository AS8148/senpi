import "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vitest";
import {
	buildVertexAnthropicModelsUrl,
	buildVertexOpenApiBaseUrl,
	type ResolveVertexAccess,
	streamVertexClaude,
	streamVertexModelGarden,
} from "../../src/core/extensions/builtin/vertex-model-garden/transport.ts";

const access: ResolveVertexAccess = async () => ({
	accessToken: "adc-token",
	project: "proj-a",
	quotaProject: "quota-b",
});

const context = normalizeContext({
	messages: [{ role: "user", content: "read a.txt", timestamp: 0 }],
});

function model(api: Api, id: string, provider: string): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://aiplatform.googleapis.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	} as Model<Api>;
}

function sse(frames: string[]): Response {
	return new Response(frames.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };

function capturingFetch(response: () => Response, captured: Captured[]): typeof globalThis.fetch {
	return (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		captured.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
		return response();
	}) as typeof globalThis.fetch;
}

describe("vertex-model-garden URLs", () => {
	it("targets the global host for partner models and regional hosts otherwise", () => {
		expect(buildVertexOpenApiBaseUrl("p")).toBe(
			"https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi",
		);
		expect(buildVertexAnthropicModelsUrl("p", "us-east5")).toBe(
			"https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models",
		);
	});
});

describe("vertex-garden openai-compatible lane", () => {
	it("sends ADC bearer and quota project to the openapi endpoint and parses tool calls", async () => {
		const captured: Captured[] = [];
		const chunk = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
		const fetch = capturingFetch(
			() =>
				sse([
					chunk({
						id: "c1",
						object: "chat.completion.chunk",
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: "call_1",
											type: "function",
											function: { name: "read", arguments: '{"path":"a.txt"}' },
										},
									],
								},
							},
						],
					}),
					chunk({
						id: "c1",
						object: "chat.completion.chunk",
						choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
						usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
					}),
					"data: [DONE]\n\n",
				]),
			captured,
		);

		const result = await streamVertexModelGarden(
			model("openai-completions", "zai-org/glm-5.2-maas", "vertex-garden"),
			context,
			{ fetch },
			access,
		).result();

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/proj-a/locations/global/endpoints/openapi/chat/completions",
		);
		expect(captured[0].headers.get("authorization")).toBe("Bearer adc-token");
		expect(captured[0].headers.get("x-goog-user-project")).toBe("quota-b");
		expect(captured[0].body.model).toBe("zai-org/glm-5.2-maas");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }),
		);
		expect(result.usage.input).toBe(12);
		expect(result.usage.output).toBe(7);
	});
});

describe("vertex-claude rawPredict lane", () => {
	it("translates the Messages request to streamRawPredict and keeps thinking, tool calls, usage and stop reason", async () => {
		const captured: Captured[] = [];
		const event = (type: string, payload: object) =>
			`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
		const fetch = capturingFetch(
			() =>
				sse([
					event("message_start", {
						message: {
							id: "msg_1",
							type: "message",
							role: "assistant",
							model: "claude-haiku-5-5",
							content: [],
							stop_reason: null,
							usage: { input_tokens: 30, output_tokens: 1 },
						},
					}),
					event("content_block_start", {
						index: 0,
						content_block: { type: "thinking", thinking: "", signature: "" },
					}),
					event("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "need the file" } }),
					event("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }),
					event("content_block_stop", { index: 0 }),
					event("content_block_start", {
						index: 1,
						content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} },
					}),
					event("content_block_delta", {
						index: 1,
						delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
					}),
					event("content_block_stop", { index: 1 }),
					event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 22 } }),
					event("message_stop", {}),
				]),
			captured,
		);

		const result = await streamVertexClaude(
			model("anthropic-messages", "claude-haiku-5-5", "vertex-claude"),
			context,
			{ fetch },
			access,
		).result();

		expect(captured).toHaveLength(1);
		expect(captured[0].url).toBe(
			"https://aiplatform.googleapis.com/v1/projects/proj-a/locations/global/publishers/anthropic/models/claude-haiku-5-5:streamRawPredict",
		);
		expect(captured[0].body.model).toBeUndefined();
		expect(captured[0].body.anthropic_version).toBe("vertex-2023-10-16");
		expect(captured[0].body.stream).toBe(true);
		expect(captured[0].headers.get("authorization")).toBe("Bearer adc-token");
		expect(captured[0].headers.get("x-goog-user-project")).toBe("quota-b");
		expect(captured[0].headers.get("x-api-key")).toBeNull();
		expect(result.errorMessage).toBeUndefined();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toContainEqual(expect.objectContaining({ type: "thinking", thinking: "need the file" }));
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a.txt" } }),
		);
		expect(result.usage.input).toBe(30);
		expect(result.usage.output).toBe(22);
	});

	it("surfaces credential failures as a terminal error event instead of throwing", async () => {
		const failing: ResolveVertexAccess = async () => {
			throw new Error("Vertex AI requires a project ID.");
		};
		const result = await streamVertexClaude(
			model("anthropic-messages", "claude-haiku-5-5", "vertex-claude"),
			context,
			undefined,
			failing,
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("requires a project ID");
	});
});
