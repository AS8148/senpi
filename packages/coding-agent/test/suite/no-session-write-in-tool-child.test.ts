// senpi#3566 todo 4: the server is the single writer of every session file; the tool child's import graph reaches no
// session-writing module (architecture contract). The walk follows static and dynamic relative imports.
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "../..");
const ROOTS = ["src/tool-child-main.ts"];
const FORBIDDEN = [
	"src/core/session-manager.ts",
	"src/core/agent-session.ts",
	"src/core/agent-session-runtime.ts",
	"src/core/session-write-recovery.ts",
	"src/core/sdk.ts",
	"src/main.ts",
];
const SPECIFIER =
	/(?:import|export)\s[^'"]*?from\s*["'](\.{1,2}\/[^"']+)["']|import\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|import\s+["'](\.{1,2}\/[^"']+)["']/g;

function reachable(roots: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const queue = roots.map((root) => resolve(packageRoot, root));
	while (queue.length > 0) {
		const file = queue.pop();
		if (file === undefined || seen.has(file)) continue;
		seen.add(file);
		const source = readFileSync(file, "utf8");
		for (const match of source.matchAll(SPECIFIER)) {
			const specifier = match[1] ?? match[2] ?? match[3];
			if (specifier?.endsWith(".ts")) queue.push(resolve(dirname(file), specifier));
		}
	}
	return new Set([...seen].map((file) => relative(packageRoot, file)));
}

describe("the tool child never writes a session", () => {
	const graph = reachable(ROOTS);

	it("walks the tool child's real graph", () => {
		expect(graph.has("src/internal-role.ts")).toBe(true);
		expect(graph.has("src/modes/rpc/tool-child/entry.ts")).toBe(true);
		expect(graph.has("src/modes/rpc/tool-child/channel.ts")).toBe(true);
	});

	it("reaches no session-writing module", () => {
		expect(FORBIDDEN.filter((file) => graph.has(file))).toEqual([]);
	});
});
