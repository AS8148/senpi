import type { Credential } from "../types.ts";

/** A login tried to store an API-key credential whose `key` is blank or missing (#3867). */
export class EmptyApiKeyError extends Error {
	override readonly name = "EmptyApiKeyError";

	constructor() {
		super("Refusing to save an empty API key");
	}
}

/**
 * Throws `EmptyApiKeyError` when an API-key credential names a `key` that is not a non-empty
 * string. Env-only logins (AWS profile or credential chain, Vertex ADC) omit the field and pass.
 */
export function assertLoginKeyPresent(credential: Credential): void {
	if (credential.type !== "api_key" || !Object.hasOwn(credential, "key")) return;
	if (typeof credential.key === "string" && credential.key.trim() !== "") return;
	throw new EmptyApiKeyError();
}
