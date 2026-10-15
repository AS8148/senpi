import type { ProviderModelConfig } from "../../types.ts";

// This starter list covers open models through the global OpenAI-compatible endpoint.
// Marketplace partner models are excluded: they are card-billed and promotional credits do not apply.
// Costs are placeholders, not billing estimates; users can add models through models.json.
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
	garden("deepseek-ai/deepseek-v4.1-flash-maas", "DeepSeek V4.1 Flash (Vertex)", true, 1_000_000),
	garden("zai-org/glm-5.2-maas", "GLM 5.2 (Vertex)", true, 200_000),
];
