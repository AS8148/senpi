import {
	type ConfigReference,
	ConfigReferenceError,
	isConfigReference,
} from "@earendil-works/pi-ai/utils/config-reference";
import { rememberConfigReferenceOrigin } from "../../../config-reference-resolver.ts";
import type { McpServerDeclaration } from "./config-schema.ts";

export interface McpServerReference {
	readonly field: string;
	readonly reference: ConfigReference;
}

/** The accepting positions of one declared server: `headers.*`, `env.*` and `args[]`. */
export function mcpServerReferences(name: string, server: McpServerDeclaration): McpServerReference[] {
	const found: McpServerReference[] = [];
	const visit = (value: unknown, field: string) => {
		if (isConfigReference(value)) found.push({ field: `mcpServers.${name}.${field}`, reference: value });
	};
	for (const [key, value] of Object.entries(server.headers ?? {})) visit(value, `headers.${key}`);
	for (const [key, value] of Object.entries(server.env ?? {})) visit(value, `env.${key}`);
	for (const [index, value] of (server.args ?? []).entries()) visit(value, `args.${index}`);
	return found;
}

/** Called as a trusted file is read, so each reference resolves against the file that declares it. */
export function rememberMcpReferenceOrigins(
	servers: Readonly<Record<string, McpServerDeclaration>> | undefined,
	origin: string,
): void {
	for (const [name, server] of Object.entries(servers ?? {})) {
		for (const { field, reference } of mcpServerReferences(name, server)) {
			rememberConfigReferenceOrigin(reference, { origin, authority: "trusted", field });
		}
	}
}

/** A source that does not expand legacy `${NAME}` refuses every reference before any I/O. */
export function refuseMcpReferences(name: string, server: McpServerDeclaration): void {
	const [first] = mcpServerReferences(name, server);
	if (first !== undefined) throw new ConfigReferenceError(first.field, first.reference, "forbidden");
}
