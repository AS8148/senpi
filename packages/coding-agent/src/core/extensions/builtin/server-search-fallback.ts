// Request-local metadata: Symbols survive hook-to-hook object spreads, but are
// omitted by JSON.stringify and never reach the provider or stored transcript.
export const SERVER_SEARCH_FALLBACK = Symbol.for("senpi.serverSearchFallback");

export function isServerSearchFallback(payload: unknown): boolean {
	return (
		payload !== null &&
		typeof payload === "object" &&
		SERVER_SEARCH_FALLBACK in payload &&
		payload[SERVER_SEARCH_FALLBACK] === true
	);
}
