import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { isAnthropicWebSearchEnabled, supportsNativeAnthropicWebSearch } from "../anthropic-web-search/index.ts";
import { isOpenaiWebSearchEnabled, supportsNativeOpenAiWebSearch } from "../openai-web-search/index.ts";
import { SERVER_SEARCH_FALLBACK } from "../server-search-fallback.ts";

export type SearchModel = Pick<Model<Api>, "api" | "provider" | "id" | "baseUrl" | "compat">;
type Payload = Record<string, unknown>;
type FunctionSearch = { name: string; description: string; parameters: unknown };
type AdditionalServerSearch = "google" | "openrouter" | "perplexity" | "moonshot" | "zai";

function isRecord(value: unknown): value is Payload {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function additionalServerSearch(model: SearchModel | undefined): AdditionalServerSearch | undefined {
	if (!model) return undefined;
	const declared = model.compat && "supportsWebSearch" in model.compat ? model.compat.supportsWebSearch : undefined;
	if (declared === false) return undefined;
	// Google Search grounding uses GenerateContent config.tools, not Messages/Responses.
	// Gemini 3 supports combining grounding with the function tools a coding session needs.
	// https://ai.google.dev/gemini-api/docs/google-search
	// https://github.com/googleapis/js-genai/blob/main/codegen_instructions.md
	if (
		(model.api === "google-generative-ai" || model.api === "google-vertex") &&
		/^gemini-3/.test(model.id) &&
		!/(image|live|tts|embedding|computer-use)/.test(model.id)
	) {
		return "google";
	}
	// OpenRouter's own server tool works on Chat Completions and Responses.
	// Do not translate it into the upstream vendor's tool shape.
	// https://openrouter.ai/docs/guides/features/server-tools/web-search
	if (model.provider === "openrouter" && (model.api === "openai-completions" || model.api === "openai-responses")) {
		return "openrouter";
	}
	// PAYG Moonshot executes $web_search and returns its result in generated
	// arguments; the client echoes those arguments as a tool result, without
	// making another search request. This is NOT the Kimi coding-plan endpoint.
	// https://platform.kimi.ai/docs/guide/use-web-search
	if (model.api === "openai-completions" && (model.provider === "moonshotai" || model.provider === "moonshotai-cn")) {
		return "moonshot";
	}
	// The same provider id can point at PAYG chat or the coding-plan endpoint.
	// Only an explicit per-route flag enables the PAYG in-chat server tool.
	// https://docs.z.ai/guides/tools/web-search
	// https://docs.z.ai/devpack/mcp/search-mcp-server
	if (
		model.api === "openai-completions" &&
		(model.provider === "zai" || model.provider === "z-ai") &&
		declared === true
	) {
		return "zai";
	}
	// Sonar searches inside the main completion without a tools[] declaration.
	// Synchronous Sonar calls are now reformulated as Agent API calls upstream.
	// https://docs.perplexity.ai/docs/sonar/quickstart
	if (model.provider === "perplexity" && model.api === "openai-completions" && /^sonar/.test(model.id)) {
		return "perplexity";
	}
	// DeepSeek documents search on /anthropic, not the default Chat Completions API.
	// An Anthropic-format model opts in through compat.supportsWebSearch, including replay.
	// https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
	// Kimi coding-plan docs do not specify a search/replay contract. Keep the explicit
	// Messages compat opt-in; do not confuse it with PAYG's deprecated $web_search.
	// https://www.kimi.com/code/docs/en/third-party-tools/claude-code
	// https://platform.kimi.ai/docs/guide/use-web-search
	// GLM coding-plan search is documented as webSearchPrime over remote MCP, not
	// the PAYG chat tool. Do not inject the PAYG tool on the coding endpoint.
	// https://docs.z.ai/devpack/mcp/search-mcp-server
	// https://docs.z.ai/guides/tools/web-search
	return undefined;
}

export function hasServerSearch(model: SearchModel | undefined): boolean {
	if (!model) return false;
	return (
		(supportsNativeAnthropicWebSearch(model) && isAnthropicWebSearchEnabled()) ||
		(supportsNativeOpenAiWebSearch(model) && isOpenaiWebSearchEnabled()) ||
		additionalServerSearch(model) !== undefined
	);
}

function isSearchTool(tool: unknown): boolean {
	if (!isRecord(tool)) return false;
	return (
		tool.name === "web_search" ||
		tool.name === "$web_search" ||
		(isRecord(tool.function) && (tool.function.name === "web_search" || tool.function.name === "$web_search")) ||
		(typeof tool.type === "string" &&
			(tool.type === "openrouter:web_search" || tool.type === "web_search" || tool.type.startsWith("web_search_")))
	);
}

function googleTools(tools: unknown[], fallback?: FunctionSearch): unknown[] {
	const result: unknown[] = [];
	for (const tool of tools) {
		if (!isRecord(tool) || "googleSearch" in tool || "google_search" in tool) continue;
		if (!Array.isArray(tool.functionDeclarations)) {
			result.push(tool);
			continue;
		}
		const declarations = tool.functionDeclarations.filter(
			(declaration) => !isRecord(declaration) || declaration.name !== "web_search",
		);
		if (declarations.length) result.push({ ...tool, functionDeclarations: declarations });
	}
	result.push(
		fallback
			? {
					functionDeclarations: [
						{ name: fallback.name, description: fallback.description, parametersJsonSchema: fallback.parameters },
					],
				}
			: { googleSearch: {} },
	);
	return result;
}

/** Restore function search after failure, regardless of native-injector registration order. */
export function serverSearchPayload(
	model: SearchModel | undefined,
	payload: unknown,
	fallback?: FunctionSearch,
): unknown {
	if (!model || !isRecord(payload)) return payload;
	const google = model.api === "google-generative-ai" || model.api === "google-vertex";
	if (google && (additionalServerSearch(model) === "google" || fallback)) {
		const config = isRecord(payload.config) ? payload.config : {};
		const tools = Array.isArray(config.tools) ? config.tools : [];
		return {
			...payload,
			config: { ...config, tools: googleTools(tools, fallback) },
			...(fallback ? { [SERVER_SEARCH_FALLBACK]: true } : {}),
		};
	}
	const kind = additionalServerSearch(model);
	if (!fallback && !kind) return payload;
	const tools = (Array.isArray(payload.tools) ? payload.tools : []).filter((tool) => !isSearchTool(tool));
	if (fallback) {
		if (model.api === "anthropic-messages") {
			tools.push({ name: fallback.name, description: fallback.description, input_schema: fallback.parameters });
		} else if (model.api === "openai-completions") {
			tools.push({
				type: "function",
				function: { name: fallback.name, description: fallback.description, parameters: fallback.parameters },
			});
		} else {
			tools.push({
				type: "function",
				name: fallback.name,
				description: fallback.description,
				parameters: fallback.parameters,
			});
		}
	} else if (kind === "openrouter") {
		tools.push({ type: "openrouter:web_search" });
	} else if (kind === "moonshot") {
		tools.push({ type: "builtin_function", function: { name: "$web_search" } });
	} else if (kind === "zai") {
		tools.push({ type: "web_search", web_search: { enable: true, search_result: true } });
	}
	const result: Payload = { ...payload, tools };
	if (fallback) {
		// An include or tool_choice targeting the removed server tool would reject the retry.
		if (Array.isArray(result.include)) {
			result.include = result.include.filter((item) => item !== "web_search_call.action.sources");
		}
		if (isRecord(result.tool_choice) && isSearchTool(result.tool_choice)) delete result.tool_choice;
	}
	return fallback ? { ...result, [SERVER_SEARCH_FALLBACK]: true } : result;
}

/** Only search-specific errors trigger fallback; cancellation and unrelated provider failures do not. */
export function serverSearchFailure(
	message: Pick<AssistantMessage, "stopReason" | "content" | "errorMessage">,
	model?: SearchModel,
): string | undefined {
	if (message.stopReason === "aborted") return undefined;
	// Sonar has inherent retrieval, not an independent server tool declaration or
	// tool-result error contract. Its model errors stay with core retry; never
	// turn an arbitrary Sonar error into an unsupported function-tool request.
	if (additionalServerSearch(model) === "perplexity") return undefined;
	for (const block of message.content) {
		if (block.type !== "providerNative" || !isRecord(block.raw)) continue;
		const raw = block.raw;
		if (raw.type === "web_search_call" && raw.status === "failed") {
			return "server search result: failed";
		}
		if (raw.type !== "web_search_tool_result" || !isRecord(raw.content)) continue;
		if (raw.content.type === "web_search_tool_result_error" && typeof raw.content.error_code === "string") {
			return `server search result: ${raw.content.error_code.replace(/[^a-z_]/g, "").slice(0, 60)}`;
		}
	}
	if (
		message.stopReason === "error" &&
		!/(\b401\b|invalid[_ -]?(?:api[_ -]?)?key|authentication|unauthorized|quota|billing|insufficient)/i.test(
			message.errorMessage ?? "",
		) &&
		/(web_search_\d{8}|web_search_preview|openrouter:web_search|googleSearch|google_search|(?:tool(?:[_ -]?type)?|type)\s*[:=]?\s*["']?web_search\b)/i.test(
			message.errorMessage ?? "",
		)
	) {
		const status = message.errorMessage?.match(/\b(400|403|429|500|502|503)\b/)?.[1];
		return `server search request rejected${status ? ` (HTTP ${status})` : ""}`;
	}
	return undefined;
}
