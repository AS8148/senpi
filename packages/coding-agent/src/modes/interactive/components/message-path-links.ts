import { pathToFileURL } from "node:url";

import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { messagePathProjectRoot, resolveMessagePath } from "../../../core/message-path-resolution.ts";

/**
 * Links in a message whose target is a path (`[plan](docs/plan.md)`, `[out](./out/report.pdf)`)
 * become `file://` links to the file the engine's one rule finds (`resolveMessagePath`: the
 * session's working directory, then the project root), so the terminal opens the same file the
 * desktop app and RPC clients do (#3415). URLs, anchors, code blocks and inline code are left
 * alone, and a path that resolves to nothing keeps its text.
 */

const FENCE = /^\s{0,3}(```|~~~)/;
const LINK_TARGET = /\]\(([^)\s]+)\)/g;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CACHE_LIMIT = 256;

export function createMessagePathLinkTransformer(getCwd: () => string): MarkdownTransformer {
	const resolved = new Map<string, string>();

	const fileUrlFor = (target: string, cwd: string): string | undefined => {
		const hashAt = target.indexOf("#");
		const path = hashAt === -1 ? target : target.slice(0, hashAt);
		const fragment = hashAt === -1 ? "" : target.slice(hashAt);
		if (path.length === 0) return undefined;
		const key = `${cwd}\0${path}`;
		const cached = resolved.get(key);
		if (cached !== undefined) return cached + fragment;
		const answer = resolveMessagePath({ path: decodeURI(path), cwd, projectRoot: messagePathProjectRoot(cwd) });
		if (answer.status !== "found") return undefined;
		const url = pathToFileURL(answer.realpath).href;
		if (resolved.size >= CACHE_LIMIT) resolved.delete(resolved.keys().next().value ?? "");
		resolved.set(key, url);
		return url + fragment;
	};

	const rewriteOutsideCode = (line: string, cwd: string): string =>
		line
			.split(/(`+[^`]*`+)/)
			.map((part, index) =>
				index % 2 === 1
					? part
					: part.replace(LINK_TARGET, (whole, target: string) => {
							if (SCHEME.test(target) || target.startsWith("#")) return whole;
							const url = fileUrlFor(target, cwd);
							return url === undefined ? whole : `](${url})`;
						}),
			)
			.join("");

	return (markdown) => {
		if (!markdown.includes("](")) return markdown;
		const cwd = getCwd();
		let inFence = false;
		return markdown
			.split("\n")
			.map((line) => {
				if (FENCE.test(line)) {
					inFence = !inFence;
					return line;
				}
				return inFence ? line : rewriteOutsideCode(line, cwd);
			})
			.join("\n");
	};
}
