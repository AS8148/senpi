import {
	type Api,
	type AssistantMessageEventStream,
	getApiProvider,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getVertexAdcAccess, type VertexAdcAccess } from "@earendil-works/pi-ai/api/google-vertex-adc.lazy";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";

export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";
export const VERTEX_PARTNER_LOCATION = "global";

export type ResolveVertexAccess = (options?: SimpleStreamOptions) => Promise<VertexAdcAccess>;

export const defaultResolveVertexAccess: ResolveVertexAccess = (options) =>
	getVertexAdcAccess({ project: options?.apiKey, env: options?.env });

export function vertexHost(location: string): string {
	return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}

export function buildVertexOpenApiBaseUrl(project: string, location: string = VERTEX_PARTNER_LOCATION): string {
	return `https://${vertexHost(location)}/v1/projects/${encodeURIComponent(project)}/locations/${location}/endpoints/openapi`;
}

export function buildVertexAnthropicModelsUrl(project: string, location: string = VERTEX_PARTNER_LOCATION): string {
	return `https://${vertexHost(location)}/v1/projects/${encodeURIComponent(project)}/locations/${location}/publishers/anthropic/models`;
}

export function buildVertexAnthropicPredictUrl(modelsUrl: string, modelId: string, stream: boolean): string {
	return `${modelsUrl}/${encodeURIComponent(modelId)}:${stream ? "streamRawPredict" : "rawPredict"}`;
}

/**
 * Rewrites an Anthropic Messages request into Vertex rawPredict form: the model
 * moves from the body into the URL, `anthropic_version` is added to the body,
 * and the SDK's API-key header is replaced by the ADC bearer token.
 */
export function translateAnthropicRequestForVertex(
	url: string,
	init: RequestInit | undefined,
	modelsUrl: string,
	access: VertexAdcAccess,
): { url: string; init: RequestInit } {
	const path = new URL(url).pathname;
	if (!path.endsWith("/v1/messages")) {
		throw new Error(`Claude on Vertex AI does not support ${path}`);
	}
	if (typeof init?.body !== "string") throw new Error("Claude on Vertex AI expects a JSON request body");
	const body = JSON.parse(init.body) as Record<string, unknown>;
	const modelId = body.model;
	if (typeof modelId !== "string" || modelId.length === 0) throw new Error("Anthropic request body has no model");
	delete body.model;
	body.anthropic_version = VERTEX_ANTHROPIC_VERSION;

	const headers = new Headers(init.headers);
	headers.delete("x-api-key");
	headers.delete("anthropic-version");
	headers.set("authorization", `Bearer ${access.accessToken}`);
	headers.set("x-goog-user-project", access.quotaProject);
	headers.set("content-type", "application/json");

	return {
		url: buildVertexAnthropicPredictUrl(modelsUrl, modelId, body.stream === true),
		init: { ...init, headers, body: JSON.stringify(body) },
	};
}

export function createVertexAnthropicFetch(
	modelsUrl: string,
	access: VertexAdcAccess,
	baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
	const vertexFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const translated = translateAnthropicRequestForVertex(url, init, modelsUrl, access);
		return baseFetch(translated.url, translated.init);
	};
	return vertexFetch as typeof globalThis.fetch;
}

function requireApi(api: Api) {
	const provider = getApiProvider(api);
	if (!provider) throw new Error(`API provider ${api} is not registered`);
	return provider;
}

export function streamVertexModelGarden(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	resolveAccess: ResolveVertexAccess = defaultResolveVertexAccess,
): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		const access = await resolveAccess(options);
		const target = { ...model, baseUrl: buildVertexOpenApiBaseUrl(access.project) };
		return requireApi("openai-completions").streamSimple(target, context, {
			...options,
			apiKey: access.accessToken,
			headers: { ...options?.headers, "x-goog-user-project": access.quotaProject },
		});
	});
}

export function streamVertexClaude(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	resolveAccess: ResolveVertexAccess = defaultResolveVertexAccess,
): AssistantMessageEventStream {
	return lazyStream(model, async () => {
		const access = await resolveAccess(options);
		const modelsUrl = buildVertexAnthropicModelsUrl(access.project);
		return requireApi("anthropic-messages").streamSimple({ ...model, baseUrl: modelsUrl }, context, {
			...options,
			apiKey: access.accessToken,
			fetch: createVertexAnthropicFetch(modelsUrl, access, options?.fetch),
		});
	});
}
