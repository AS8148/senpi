import { z } from "zod";
import {
	buildModernRequest,
	classifyModernError,
	deriveModernHeaders,
	MODERN_PROTOCOL_VERSION,
	type ModernClientInfo,
	type ModernError,
	type ModernRequest,
} from "./wire.ts";

export { MODERN_PROTOCOL_VERSION } from "./wire.ts";
export interface ProbeOptions {
	readonly clientInfo: ModernClientInfo;
	readonly clientCapabilities: Readonly<Record<string, unknown>>;
	readonly supportedVersions: readonly string[];
}
export type ProbeRequest = ModernRequest;
const discoverySchema = z
	.object({
		resultType: z.literal("complete"),
		supportedVersions: z.array(z.string()),
		capabilities: z.record(z.string(), z.unknown()),
		_meta: z
			.object({
				"io.modelcontextprotocol/serverInfo": z.object({ name: z.string(), version: z.string() }).passthrough(),
			})
			.passthrough(),
		instructions: z.string().optional(),
		ttlMs: z.number().nonnegative().optional(),
		cacheScope: z.string().optional(),
	})
	.passthrough();

export type { ModernError } from "./wire.ts";
export type DiscoveryResult = z.infer<typeof discoverySchema>;
type ModernOutcome = {
	readonly kind: "modern-OK" | "modern-version-retry";
	readonly version: string;
	readonly discovery?: DiscoveryResult;
	readonly error?: ModernError;
};
export type EraOutcome =
	| ModernOutcome
	| { readonly kind: "legacy-fallback" }
	| {
			readonly kind: "indeterminate";
			readonly reason: string;
			readonly action: string;
			readonly era?: "modern";
			readonly status?: number;
			readonly cause?: unknown;
	  };
export type ProbeFetch = (url: URL, init: RequestInit) => Promise<Response>;
export type ProbeSend = (request: ProbeRequest) => Promise<unknown>;

export const modernError = classifyModernError;

function request(options: ProbeOptions, version: string): ProbeRequest {
	const built = buildModernRequest(1, "server/discover", options.clientInfo, options.clientCapabilities);
	return {
		...built,
		params: {
			_meta: {
				...built.params._meta,
				"io.modelcontextprotocol/protocolVersion": version,
			},
		},
	};
}

function complete(value: unknown): DiscoveryResult | undefined {
	const parsed = z.object({ jsonrpc: z.literal("2.0"), id: z.literal(1), result: discoverySchema }).safeParse(value);
	return parsed.success ? parsed.data.result : undefined;
}

function indeterminate(
	reason: string,
	action: string,
	details: {
		readonly era?: "modern";
		readonly status?: number;
		readonly cause?: unknown;
	} = {},
): EraOutcome {
	return { kind: "indeterminate", reason, action, ...details };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

async function body(response: Response): Promise<unknown> {
	const text = await response.text();
	if (!response.headers.get("Content-Type")?.includes("text/event-stream")) return parseJson(text);
	// This consumes only the POST's response stream, never a standalone GET.
	for (const event of text.replace(/\r\n/g, "\n").split("\n\n")) {
		const data = event
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).replace(/^ /, ""))
			.join("\n");
		const value = parseJson(data);
		if (complete(value) || modernError(value)) return value;
	}
	return undefined;
}

export async function probeHttpEra(url: URL, fetch: ProbeFetch, options: ProbeOptions): Promise<EraOutcome> {
	let version = MODERN_PROTOCOL_VERSION;
	for (let attempt = 0; attempt < 2; attempt++) {
		let response: Response;
		let value: unknown;
		try {
			const discoveryRequest = request(options, version);
			response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...deriveModernHeaders(discoveryRequest),
				},
				body: JSON.stringify(discoveryRequest),
			});
			value = await body(response);
		} catch (cause) {
			return indeterminate("transport", "Check the MCP endpoint connection and retry discovery.", { cause });
		}
		const error = modernError(value);
		if (response.status === 400) {
			if (!error) {
				return attempt === 0
					? { kind: "legacy-fallback" }
					: indeterminate("version-retry-rejected", "Check server version negotiation; the modern retry failed.", {
							era: "modern",
						});
			}
			if (error.code !== -32022) return { kind: attempt ? "modern-version-retry" : "modern-OK", version, error };
			if (attempt === 1) {
				return indeterminate(
					"version-retry-rejected",
					"Update client or server; the single version retry was rejected.",
					{ era: "modern" },
				);
			}
			const mutual = error.supportedVersions
				? error.supportedVersions
						.filter((candidate) => options.supportedVersions.includes(candidate))
						.sort()
						.at(-1)
				: undefined;
			if (!mutual) {
				return indeterminate(
					"no-mutual-version",
					"Update client or server to share a supported protocol version.",
					{ era: "modern" },
				);
			}
			version = mutual;
			continue;
		}
		if (!response.ok)
			return indeterminate("http-status", "Check endpoint, authentication, or server health before retrying.", {
				status: response.status,
			});
		const discovery = complete(value);
		if (discovery) return { kind: attempt ? "modern-version-retry" : "modern-OK", version, discovery };
		if (error) return { kind: attempt ? "modern-version-retry" : "modern-OK", version, error };
		return indeterminate("invalid-discovery", "Check that the server returns a complete server/discover envelope.");
	}
	return indeterminate("version-retry-rejected", "Update client or server protocol versions.", { era: "modern" });
}

export async function probeStdioEra(send: ProbeSend, options: ProbeOptions): Promise<EraOutcome> {
	let value: unknown;
	try {
		value = await send(request(options, MODERN_PROTOCOL_VERSION));
	} catch (error) {
		value = { jsonrpc: "2.0", error };
	}
	const discovery = complete(value);
	if (discovery) return { kind: "modern-OK", version: MODERN_PROTOCOL_VERSION, discovery };
	const error = modernError(value);
	return error ? { kind: "modern-OK", version: MODERN_PROTOCOL_VERSION, error } : { kind: "legacy-fallback" };
}
