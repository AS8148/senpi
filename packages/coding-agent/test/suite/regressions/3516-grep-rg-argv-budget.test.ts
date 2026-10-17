import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GrepEngineRequest } from "../../../src/core/tools/grep/engine.ts";
import { matcherFlags, segmentFlags, walkerFlags } from "../../../src/core/tools/grep/rg/args.ts";
import { argvBudget, argvCost, EXECUTABLE_RESERVE, packArgv } from "../../../src/core/tools/grep/rg/argv.ts";
import type { Candidate, Root } from "../../../src/core/tools/grep/rg/enumerate.ts";
import { planSegments } from "../../../src/core/tools/grep/rg/segments.ts";

const base = "/work/repo";
const platforms = ["win32", "darwin"] as const;

function fileCandidate(index: number, name = "f.ts"): Candidate {
	const path = join(base, `d${String(index).padStart(4, "0")}`, name);
	const root: Root = { path, alias: path, cwd: join(path, ".."), file: true };
	return { absolute: path, canonical: path, display: path, root, size: 10, ordinal: index + 1, binary: false };
}

function treeCandidates(count: number): Candidate[] {
	const root: Root = { path: base, alias: base, cwd: base, file: false };
	return Array.from({ length: count }, (_, index) => {
		const absolute = join(base, "src dir", `module "${String(index).padStart(5, "0")}".ts`);
		return { absolute, canonical: absolute, display: absolute, root, size: 10, ordinal: index + 1, binary: false };
	});
}

function commandLine(argv: string[], platform: NodeJS.Platform): number {
	return EXECUTABLE_RESERVE + argv.reduce((sum, argument) => sum + argvCost(argument, platform), 0);
}

function heavyRequest(): GrepEngineRequest {
	const glob = Array.from({ length: 60 }, (_, index) => `!**/generated-${index}/**/*.snapshot.ts`);
	return {
		pattern: Array.from({ length: 700 }, (_, index) => `ident${index}`).join("|"),
		paths: [base],
		cwd: base,
		glob,
	};
}

describe("#3516 rg launches fit the whole OS command line", () => {
	it("keeps the Windows budget under the 32,767-character command line", () => {
		expect(argvBudget("win32")).toBeLessThanOrEqual(32_767);
		expect(argvBudget("darwin")).toBeLessThan(1024 * 1024);
	});

	it("counts Windows quoting: quotes, escaped quotes and doubled trailing backslashes", () => {
		expect(argvCost("ab", "darwin")).toBe(3);
		expect(argvCost("a b", "win32")).toBe(6);
		expect(argvCost('a"b', "win32")).toBe(7);
		expect(argvCost("C:\\dir\\", "win32")).toBe("C:\\dir\\".length + 3 + 1);
	});

	for (const platform of platforms) {
		it(`splits with a long pattern and many globs under the ${platform} budget`, () => {
			const request = heavyRequest();
			const walk = walkerFlags(request);
			const matcher = matcherFlags(request);
			const budget = argvBudget(platform);
			const scale = platform === "win32" ? 1 : 10;
			const files = Array.from({ length: 1500 * scale }, (_, index) => fileCandidate(index));
			for (const candidates of [treeCandidates(1000 * scale), files]) {
				const segments = planSegments(candidates, request, { walk, matcher, platform });

				expect(segments.length).toBeGreaterThan(1);
				expect(segments.flat()).toEqual(candidates);
				for (const segment of segments) {
					const argv = segmentFlags(segment, request.pattern, walk, matcher);
					expect(argv).toContain(request.pattern);
					expect(commandLine(argv, platform)).toBeLessThanOrEqual(budget);
				}
				// Each launch is filled close to the limit, not split needlessly.
				const first = segmentFlags(segments[0], request.pattern, walk, matcher);
				expect(commandLine(first, platform)).toBeGreaterThan(budget - 400);
			}
		});
	}

	it("gives an argument that cannot share a launch its own launch instead of truncating it", () => {
		const long = fileCandidate(1, `${"x".repeat(400)}.ts`);
		const files = [fileCandidate(0), long, fileCandidate(2)];
		const request: GrepEngineRequest = { pattern: "needle", paths: [base], cwd: base };
		const budget = commandLine(segmentFlags([files[0]], "needle", [], []), "darwin") + 100;
		const segments = planSegments(files, request, { walk: [], matcher: [], budget, platform: "darwin" });

		expect(segments).toEqual([[files[0]], [long], [files[2]]]);
		expect(segmentFlags([long], "needle", [], []).at(-1)).toBe(long.root.path);
		expect(packArgv(["a", "b".repeat(50), "c"], (item) => item.length + 1, 10)).toEqual([
			["a"],
			["b".repeat(50)],
			["c"],
		]);
	});
});
