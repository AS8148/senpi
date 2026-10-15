/**
 * The wider "Allow always" a prompt may offer for a tool WITHOUT its own permission parser, where
 * plain "Allow always" remembers only the exact argument (one URL, one input) and so asks again for
 * the next one (senpi#3403):
 * - a URL argument: that URL's DOMAIN (scheme + canonical host + non-default port), stored as one
 *   literal and matched by equality, never the whole tool: a tool-wide allow for a browser or
 *   fetch tool would mean "go anywhere", close to Full access for the web;
 * - a free `input`/`pattern` argument: the tool itself, for this project;
 * - a command or a path: nothing wider (that would grant a shell or file access wholesale).
 * Built-in tools (bash, eval, edit, write, read, ...) have parsers and never reach this.
 */
export interface WiderAlwaysScope {
	/** The option label, stating the scope in plain words. */
	readonly label: string;
	/** The patterns an answer with this option approves for the permission. */
	readonly patterns: string[];
}

/** Never widened, even if a future change routes one of them through the fallback. */
const NEVER_WIDENED = new Set([
	"bash",
	"eval",
	"edit",
	"write",
	"read",
	"apply_patch",
	"multiedit",
	"glob",
	"grep",
	"ls",
]);

/** A host the scope may name: lowercase DNS letters, digits, dots and dashes, or a bracketed IPv6 address. */
const SAFE_HOST = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/;

/**
 * The one normalizer both sides of a domain grant go through (senpi#3403): scheme, the host as the
 * URL parser canonicalizes it (lowercased, IDN to punycode), and the port only when it is not the
 * scheme's default; no userinfo, path, query or fragment. `undefined` for a non-http(s) URL, or a
 * host holding anything but DNS characters (`*`, `?`, `[` ... could make a pattern match more).
 */
export function canonicalUrlOrigin(raw: string): string | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
	if (!SAFE_HOST.test(url.hostname)) return undefined;
	return `${url.protocol}//${url.host}`;
}

/**
 * The match target a domain grant is written for: a literal that never contains a wildcard
 * character, so the grant matches by equality. The `origin=` prefix keeps it from colliding with a
 * user's own URL rules.
 */
export function urlOriginAlias(raw: string): string | undefined {
	const origin = canonicalUrlOrigin(raw);
	return origin === undefined ? undefined : `origin=${origin}`;
}

export function widerAlwaysScope(toolName: string, argKey: string, arg: string): WiderAlwaysScope | undefined {
	if (NEVER_WIDENED.has(toolName)) return undefined;
	if (argKey === "url") {
		const alias = urlOriginAlias(arg);
		const origin = canonicalUrlOrigin(arg);
		if (alias === undefined || origin === undefined) return undefined;
		return {
			label: `Allow ${toolName} on ${new URL(origin).host} always in this project`,
			patterns: [alias],
		};
	}
	if (argKey === "input" || argKey === "pattern") {
		return { label: `Allow ${toolName} always in this project`, patterns: ["*"] };
	}
	return undefined;
}
