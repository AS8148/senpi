/**
 * Which keys hold credentials (#3524). The decision is made from the key's name
 * alone: a value under a sensitive key is replaced whole, whatever it contains,
 * so no value shape (placeholders, hex, several words) can slip through. Names
 * are split into words across camelCase, snake_case, kebab-case and dots.
 *
 * A name is ordinary only when EVERY sensitive word in it is explained by an
 * exempt phrase ("public key", "key id", "max tokens") or the whole name ends in
 * a word that describes a credential rather than holding it (`*_PATH`, `*_MODE`).
 * One unexplained sensitive word anywhere makes the name sensitive, so
 * `PUBLIC_KEY_SECRET` or `NEXT_AUTH_SECRET` cannot hide behind an allowed word.
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

/** A last word that makes the whole name describe a credential rather than hold it. */
const DESCRIPTIVE_LAST_WORDS = new Set([
	"path",
	"dir",
	"file",
	"url",
	"uri",
	"mode",
	"type",
	"format",
	"length",
	"size",
	"count",
	"limit",
	"budget",
	"usage",
]);
const SIZE_WORDS = new Set(["max", "min", "num", "total"]);

function words(name: string): string[] {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

/** Whether the sensitive word at `index` is part of an exempt phrase. */
function explained(parts: readonly string[], index: number): boolean {
	const word = parts[index] ?? "";
	const before = parts[index - 1];
	const after = parts[index + 1];
	if ((word === "key" || word === "keys") && (before === "public" || after === "id" || after === "ids")) return true;
	if ((word === "token" || word === "tokens") && before !== undefined && SIZE_WORDS.has(before)) return true;
	return false;
}

/** True when a value under this key name must be replaced whole. */
export function isSensitiveKeyName(name: string): boolean {
	const parts = words(name);
	const sensitive = parts.flatMap((word, index) => (SENSITIVE_WORDS.has(word) ? [index] : []));
	if (sensitive.length === 0) return false;
	if (DESCRIPTIVE_LAST_WORDS.has(parts[parts.length - 1] ?? "")) return false;
	return sensitive.some((index) => !explained(parts, index));
}
