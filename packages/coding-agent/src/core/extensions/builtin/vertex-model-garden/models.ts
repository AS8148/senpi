import type { ProviderModelConfig } from "../../types.ts";

// Vertex publishes no machine-readable context/output limits for partner models, so this
// starter list is extension-local and limited to models that answered a live call; users
// add more through models.json under the same provider id.
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const OPENAPI_COMPAT = { supportsDeveloperRole: false, supportsReasoningEffort: false };

function garden(id: string, name: string, reasoning: boolean, contextWindow: number): ProviderModelConfig {
	return {
		id,
		name,
		reasoning,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow,
		maxTokens: 32_000,
		compat: OPENAPI_COMPAT,
	};
}

export const VERTEX_MODEL_GARDEN_MODELS: ProviderModelConfig[] = [
	garden("zai-org/glm-5.2-maas", "GLM 5.2 (Vertex)", true, 200_000),
	garden("zai-org/glm-4.7-maas", "GLM 4.7 (Vertex)", true, 200_000),
	garden("deepseek-ai/deepseek-v3.2-maas", "DeepSeek V3.2 (Vertex)", false, 128_000),
	garden("qwen/qwen3-coder-480b-a35b-instruct-maas", "Qwen3 Coder 480B (Vertex)", false, 256_000),
	garden("moonshotai/kimi-k2-thinking-maas", "Kimi K2 Thinking (Vertex)", true, 256_000),
	garden("minimaxai/minimax-m2-maas", "MiniMax M2 (Vertex)", true, 196_000),
	garden("openai/gpt-oss-120b-maas", "gpt-oss 120B (Vertex)", true, 128_000),
	garden("xai/grok-4.20-non-reasoning", "Grok 4.20 (Vertex)", false, 256_000),
];

function claude(id: string, name: string, contextWindow: number): ProviderModelConfig {
	return {
		id,
		name,
		reasoning: true,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow,
		maxTokens: 64_000,
	};
}

export const VERTEX_CLAUDE_MODELS: ProviderModelConfig[] = [
	claude("claude-opus-5-5", "Claude Opus 5.5 (Vertex)", 1_000_000),
	claude("claude-sonnet-5-5", "Claude Sonnet 5.5 (Vertex)", 1_000_000),
	claude("claude-haiku-5-5", "Claude Haiku 5.5 (Vertex)", 200_000),
];
