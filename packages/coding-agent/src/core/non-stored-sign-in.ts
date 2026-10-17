export interface CredentialSources {
	readonly runtimeKey: boolean;
	readonly stored: boolean;
	readonly configuredKey: boolean;
	readonly checkType: "oauth" | "api_key" | undefined;
}

/**
 * Whether the credential is a sign-in the provider's own check resolved (#3537). A runtime key, a
 * stored credential and a configured models.json/extension key all win first, whatever order
 * `packages/ai` runs its checks in, so a key is never reported as a sign-in.
 */
export function isNonStoredSignInFrom(sources: CredentialSources): boolean {
	if (sources.runtimeKey || sources.stored || sources.configuredKey) return false;
	return sources.checkType === "oauth";
}
