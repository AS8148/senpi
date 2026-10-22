import { createHash } from "node:crypto";
import type { McpServerDeclaredConfig } from "./config-schema.ts";

export function hashConfig(config: McpServerDeclaredConfig): string {
	// startupTimeoutMs is a client-side startup-race policy, not a connection or
	// catalog-shape input. Excluding it from the identity hash keeps the catalog
	// cache valid across upgrades (configs written before the field existed hash
	// identically) and avoids a needless reconnect when only the window changes.
	const hashable: Record<string, unknown> = { ...config };
	delete hashable.startupTimeoutMs;
	return createHash("sha256").update(stableStringify(hashable)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
