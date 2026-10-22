import type { Credential } from "@earendil-works/pi-ai";
import { isCommandConfigValue, resolveConfigValue } from "./resolve-config-value.ts";

export function validateReadOnlyAuthData(parsed: unknown): void {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid auth.json: expected an object");
	}
	for (const [providerId, credential] of Object.entries(parsed)) {
		if (typeof credential !== "object" || credential === null || Array.isArray(credential)) {
			throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
		}
		const value = credential as Record<string, unknown>;
		if (value.type === "api_key") {
			const validKey = value.key === undefined || typeof value.key === "string";
			const validEnv =
				value.env === undefined ||
				(typeof value.env === "object" &&
					value.env !== null &&
					!Array.isArray(value.env) &&
					Object.values(value.env).every((entry) => typeof entry === "string"));
			if (validKey && validEnv) continue;
		} else if (
			value.type === "oauth" &&
			typeof value.access === "string" &&
			typeof value.refresh === "string" &&
			typeof value.expires === "number" &&
			Number.isFinite(value.expires)
		) {
			continue;
		}
		throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
	}
}

export async function resolveReadOnlyCredential(credential: Credential | undefined): Promise<Credential | undefined> {
	if (!credential) return undefined;
	if (credential.type !== "api_key" || !credential.key || isCommandConfigValue(credential.key)) {
		return structuredClone(credential);
	}
	return { ...credential, key: await resolveConfigValue(credential.key, credential.env) };
}

export async function resolveStoredCredential(credential: Credential | undefined): Promise<Credential | undefined> {
	if (credential?.type !== "api_key") return credential;
	if (credential.key === undefined) return credential;
	return { ...credential, key: await resolveConfigValue(credential.key, credential.env) };
}
