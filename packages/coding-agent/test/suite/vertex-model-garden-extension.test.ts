import "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { describe, expect, it } from "vitest";
import {
	buildVertexOpenApiBaseUrl,
	type ResolveVertexAccess,
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
	it("targets the global host for open models and regional hosts otherwise", () => {
		expect(buildVertexOpenApiBaseUrl("p")).toBe(
			"https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi",
		);
		expect(buildVertexOpenApiBaseUrl("p", "us-east5")).toBe(
			"https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/endpoints/openapi",
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

describe("vertex-garden ADC failures", () => {
	it("surfaces credential failures as a terminal error event instead of throwing", async () => {
		const failing: ResolveVertexAccess = async () => {
			throw new Error("Vertex AI requires a project ID.");
		};
		const result = await streamVertexModelGarden(
			model("openai-completions", "zai-org/glm-5.2-maas", "vertex-garden"),
			context,
			undefined,
			failing,
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("requires a project ID");
	});
});
