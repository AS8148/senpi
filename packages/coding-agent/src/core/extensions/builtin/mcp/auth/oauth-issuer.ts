import type { OAuthServerInfo } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthFlowError } from "./oauth-errors.ts";
import type { McpStoredAuth } from "./token-store.ts";

// RFC 8414 section 3.3: identifiers from metadata are compared verbatim, not as normalized URLs.
export function validatedAuthorizationServerIssuer(info: OAuthServerInfo, serverName: string): string {
	// The SDK's legacy fallback discovers root metadata and spells the origin with a trailing slash.
	// Only that configured-resource fallback is normalized; PRM-provided identifiers remain exact.
	const issuer = info.resourceMetadata?.authorization_servers?.length
		? info.authorizationServerUrl
		: new URL(info.authorizationServerUrl).origin;
	if (info.authorizationServerMetadata !== undefined && info.authorizationServerMetadata.issuer !== issuer) {
		throw new OAuthFlowError(
			"needs_auth",
			`MCP server ${serverName} authorization server metadata issuer mismatch; restart authorization after correcting the server metadata.`,
			{ serverName },
		);
	}
	return issuer;
}

export function credentialsMatchIssuer(record: McpStoredAuth | undefined, issuer: string): boolean {
	const grantIssuer = record?.issuer ?? record?.discoveryState?.authorizationServerUrl;
	const clientIssuer = record?.clientInfo?.issuer ?? grantIssuer;
	return [grantIssuer, clientIssuer].every((stamp) => stamp === undefined || stamp === issuer);
}
