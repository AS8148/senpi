import { McpConfigValidationError } from "./config-error.ts";

export function interpolateValue(value: unknown, path: string, env: Record<string, string | undefined>): unknown {
	if (typeof value === "string") return interpolateString(value, path, env);
	if (Array.isArray(value)) return value.map((item, index) => interpolateValue(item, `${path}.${index}`, env));
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = interpolateValue(item, `${path}.${key}`, env);
		return out;
	}
	return value;
}

function interpolateString(value: string, path: string, env: Record<string, string | undefined>): string {
	if (value.trimStart().startsWith("!") || value.includes("$(")) {
		const displayPath = path.replace(/^mcp\./, "");
		throw new McpConfigValidationError(
			`MCP config interpolation rejected command substitution at ${displayPath}: config values may reference only environment variables for security; shell commands are never executed.`,
		);
	}
	return value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g,
		(_match, name: string, _fallback: string, fallbackValue: string | undefined) => {
			return env[name] ?? fallbackValue ?? "";
		},
	);
}
