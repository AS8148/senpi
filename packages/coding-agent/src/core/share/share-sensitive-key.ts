/**
 * Which keys hold credentials (#3524). The decision is made from the key's name
 * alone: a value under a sensitive key is replaced whole, whatever it contains,
 * so no value shape (placeholders, hex, several words) can slip through. Names
 * are split into words across camelCase, snake_case, kebab-case and dots.
 */

const SENSITIVE_WORDS = new Set([
	"key",
	"keys",
	"apikey",
	"token",
	"tokens",
	"secret",
	"secrets",
	"pass",
	"passwd",
	"password",
	"passwords",
	"passphrase",
	"pwd",
	"auth",
	"authorization",
	"credential",
	"credentials",
	"cookie",
	"cookies",
	"session",
	"sessionid",
	"private",
	"signature",
]);

/** A trailing word that makes the name describe the credential rather than hold it (`PUBLIC_KEY_PATH`, `tokenCount`). */
const DESCRIPTIVE_LAST_WORDS = new Set([
	"path",
	"dir",
	"file",
	"url",
	"uri",
	"mode",
	"type",
	"name",
	"format",
	"length",
	"size",
	"prefix",
	"header",
	"count",
	"limit",
	"budget",
	"usage",
]);
const DESCRIPTIVE_FIRST_WORDS = new Set(["max", "min", "num", "total", "public", "next", "vite"]);

function words(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

/** True when a value under this key name must be replaced whole. */
export function isSensitiveKeyName(name: string): boolean {
	const parts = words(name);
	if (!parts.some((word) => SENSITIVE_WORDS.has(word))) return false;
	if (parts.length === 1 && (parts[0] === "key" || parts[0] === "keys")) return false;
	const first = parts[0] ?? "";
	const last = parts[parts.length - 1] ?? "";
	if (DESCRIPTIVE_FIRST_WORDS.has(first) || DESCRIPTIVE_LAST_WORDS.has(last)) return false;
	if (last === "id" || last === "ids") return !parts.slice(0, -1).every((word) => word === "key" || word === "keys");
	return true;
}
