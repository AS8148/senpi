/**
 * The wider "Allow always" a prompt may offer for a tool WITHOUT its own permission parser, where
 * plain "Allow always" remembers only the exact argument (one URL, one input) and so asks again for
 * the next one (senpi#3403):
 * - a URL argument: that URL's DOMAIN (scheme + host + port), never the whole tool: a tool-wide
 *   allow for a browser or fetch tool would mean "go anywhere", close to Full access for the web;
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
const NEVER_WIDENED = new Set(["bash", "eval", "edit", "write", "read", "apply_patch", "multiedit", "glob", "grep", "ls"]);

export function widerAlwaysScope(toolName: string, argKey: string, arg: string): WiderAlwaysScope | undefined {
	if (NEVER_WIDENED.has(toolName)) return undefined;
	if (argKey === "url") {
		let url: URL;
		try {
			url = new URL(arg);
		} catch {
			return undefined;
		}
		if ((url.protocol !== "https:" && url.protocol !== "http:") || url.host === "") return undefined;
		// The origin alone, or the origin followed by "/": a host that only starts like this one
		// (example.com.evil.test, example.com@evil.test) never matches. No "?" pattern: the matcher
		// reads "?" as any one character, so `origin?*` would match example.com.evil.test. A query
		// after "/" (how browsers write it) is covered by `origin/*`; a bare `origin?q` asks.
		const origin = `${url.protocol}//${url.host}`;
		return {
			label: `Allow ${toolName} on ${url.host} always in this project`,
			patterns: [origin, `${origin}/*`],
		};
	}
	if (argKey === "input" || argKey === "pattern") {
		return { label: `Allow ${toolName} always in this project`, patterns: ["*"] };
	}
	return undefined;
}
