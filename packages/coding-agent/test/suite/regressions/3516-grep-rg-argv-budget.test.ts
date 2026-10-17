import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GrepEngineRequest } from "../../../src/core/tools/grep/engine.ts";
import { argumentCost, candidateArgument, segmentFlags } from "../../../src/core/tools/grep/rg/args.ts";
import { argvBudget, packArgv } from "../../../src/core/tools/grep/rg/argv.ts";
import type { Candidate, Root } from "../../../src/core/tools/grep/rg/enumerate.ts";
import { planSegments } from "../../../src/core/tools/grep/rg/segments.ts";

const base = "/work/repo";
const request: GrepEngineRequest = { pattern: "needle", paths: [base], cwd: base };

function fileCandidate(index: number, name = "f.ts"): Candidate {
	const path = join(base, `d${String(index).padStart(3, "0")}`, name);
	const root: Root = { path, alias: path, cwd: join(path, ".."), file: true };
	return { absolute: path, canonical: path, display: path, root, size: 10, ordinal: index + 1, binary: false };
}

function treeCandidates(count: number): Candidate[] {
	const root: Root = { path: base, alias: base, cwd: base, file: false };
	return Array.from({ length: count }, (_, index) => {
		const absolute = join(base, "src", `module-${String(index).padStart(5, "0")}.ts`);
		return { absolute, canonical: absolute, display: absolute, root, size: 10, ordinal: index + 1, binary: false };
	});
}

describe("#3516 rg launches split at the OS argument budget", () => {
	it("leaves room under the Windows command-line limit", () => {
		expect(argvBudget("win32")).toBeLessThanOrEqual(32_767 - 8_000);
		expect(argvBudget("darwin")).toBeLessThan(1024 * 1024);
	});

	it("splits explicit files into ordered launches that each fit the budget", () => {
		const files = Array.from({ length: 20 }, (_, index) => fileCandidate(index));
		const budget = argumentCost(files[0]) * 5;
		const segments = planSegments(files, request, budget);

		expect(segments.map((segment) => segment.length)).toEqual([5, 5, 5, 5]);
		expect(segments.flat()).toEqual(files);
		for (const segment of segments) {
			expect(segment.reduce((sum, candidate) => sum + argumentCost(candidate), 0)).toBeLessThanOrEqual(budget);
			const argv = segmentFlags(segment, "needle", [], []);
			expect(argv.slice(argv.indexOf("needle") + 1)).toEqual(segment.map((candidate) => candidate.root.path));
		}
	});

	it("splits an uncapped directory walk's include globs at the budget", () => {
		const candidates = treeCandidates(3000);
		const budget = argvBudget("win32");
		const segments = planSegments(candidates, request, budget);

		expect(segments.length).toBeGreaterThan(1);
		expect(segments.flat()).toEqual(candidates);
		for (const segment of segments) {
			const includes = segmentFlags(segment, "needle", [], [])
				.filter((_, index, argv) => argv[index - 1] === "-g")
				.slice(2);
			expect(includes).toEqual(segment.map(candidateArgument));
			expect(includes.join(" ").length).toBeLessThanOrEqual(budget);
		}
	});

	it("gives an argument longer than the budget its own launch instead of truncating it", () => {
		const long = fileCandidate(1, `${"x".repeat(400)}.ts`);
		const files = [fileCandidate(0), long, fileCandidate(2)];
		const segments = planSegments(files, request, 100);

		expect(segments).toEqual([[files[0]], [long], [files[2]]]);
		expect(segmentFlags([long], "needle", [], []).at(-1)).toBe(long.root.path);
		expect(packArgv(["a", "b".repeat(50), "c"], (item) => item.length + 1, 10)).toEqual([
			["a"],
			["b".repeat(50)],
			["c"],
		]);
	});
});
