/**
 * What a path in a message means (#3415): the one rule the TUI, RPC clients and the desktop app
 * share, so the same link opens the same file everywhere.
 *
 * A relative path is tried against the session's working directory first, then the project root
 * (the nearest ancestor of the working directory holding `.git`, else the nearest project marker).
 * The first candidate that exists wins, and the answer is its realpath (symlinks and `..`
 * resolved). An absolute path (or `~/...`) is only resolved and checked. This says which file a
 * link means; whether a client may read it stays the client's rule.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { findProjectRoot } from "./extensions/builtin/rules/rules/project-root.ts";

export type ResolvedMessagePath =
	| {
			readonly status: "found";
			readonly realpath: string;
			readonly kind: "file" | "directory";
			readonly base: "absolute" | "cwd" | "project-root";
	  }
	| { readonly status: "not_found"; readonly tried: readonly string[] };

/** The project root a session's relative paths fall back to, or undefined when there is none. */
export function messagePathProjectRoot(cwd: string): string | undefined {
	return findProjectRoot(cwd, [".git"]) ?? findProjectRoot(cwd) ?? undefined;
}

function existing(candidate: string): { realpath: string; kind: "file" | "directory" } | undefined {
	try {
		const realpath = realpathSync.native(candidate);
		const stats = statSync(realpath);
		if (stats.isFile()) return { realpath, kind: "file" };
		if (stats.isDirectory()) return { realpath, kind: "directory" };
		return undefined;
	} catch {
		return undefined;
	}
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	return path.startsWith("~/") || path.startsWith("~\\") ? join(homedir(), path.slice(2)) : path;
}

export function resolveMessagePath(input: {
	readonly path: string;
	readonly cwd: string;
	readonly projectRoot?: string | undefined;
}): ResolvedMessagePath {
	const path = expandHome(input.path.trim());
	if (path.length === 0 || path.includes("\0")) return { status: "not_found", tried: [] };
	const bases: ReadonlyArray<readonly ["absolute" | "cwd" | "project-root", string]> = isAbsolute(path)
		? [["absolute", path]]
		: [
				["cwd", resolve(input.cwd, path)],
				...(input.projectRoot !== undefined && resolve(input.projectRoot) !== resolve(input.cwd)
					? ([["project-root", resolve(input.projectRoot, path)]] as const)
					: []),
			];
	for (const [base, candidate] of bases) {
		const found = existing(candidate);
		if (found !== undefined) return { status: "found", ...found, base };
	}
	return { status: "not_found", tried: bases.map(([, candidate]) => candidate) };
}
