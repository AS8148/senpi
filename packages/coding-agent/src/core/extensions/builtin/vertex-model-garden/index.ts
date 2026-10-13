import type { ExtensionAPI } from "../../types.ts";
import { VERTEX_CLAUDE_MODELS, VERTEX_MODEL_GARDEN_MODELS } from "./models.ts";
import {
	defaultResolveVertexAccess,
	type ResolveVertexAccess,
	streamVertexClaude,
	streamVertexModelGarden,
} from "./transport.ts";

export const VERTEX_MODEL_GARDEN_PROVIDER_ID = "vertex-garden";
export const VERTEX_CLAUDE_PROVIDER_ID = "vertex-claude";

// The request URL is built per call from the ADC-resolved project; this only satisfies registration.
const REGISTRATION_BASE_URL = "https://aiplatform.googleapis.com/v1";
// The resolved value doubles as the target project, and its presence gates availability
// the same way the google-vertex provider requires GOOGLE_CLOUD_PROJECT for ADC.
const PROJECT_API_KEY = "$GOOGLE_CLOUD_PROJECT";

export function registerVertexModelGarden(
	pi: ExtensionAPI,
	resolveAccess: ResolveVertexAccess = defaultResolveVertexAccess,
): void {
	pi.registerProvider(VERTEX_MODEL_GARDEN_PROVIDER_ID, {
		name: "Vertex AI Model Garden",
		api: "openai-completions",
		baseUrl: REGISTRATION_BASE_URL,
		apiKey: PROJECT_API_KEY,
		models: VERTEX_MODEL_GARDEN_MODELS,
		streamSimple: (model, context, options) => streamVertexModelGarden(model, context, options, resolveAccess),
		fallbackEligible: () => false,
	});
	pi.registerProvider(VERTEX_CLAUDE_PROVIDER_ID, {
		name: "Claude on Vertex AI",
		api: "anthropic-messages",
		baseUrl: REGISTRATION_BASE_URL,
		apiKey: PROJECT_API_KEY,
		models: VERTEX_CLAUDE_MODELS,
		streamSimple: (model, context, options) => streamVertexClaude(model, context, options, resolveAccess),
		fallbackEligible: () => false,
	});
}

export default function vertexModelGardenExtension(pi: ExtensionAPI): void {
	registerVertexModelGarden(pi);
}
