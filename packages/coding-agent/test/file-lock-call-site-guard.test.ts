import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every async proper-lockfile lock must go through core/file-lock.ts, whose onCompromised never throws.
// A direct lockfile.lock( call gets the dependency's default handler, which throws from a heartbeat timer
// and kills the process when an unlock races the heartbeat stat (oh-my-openagent#10878).

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const helperPath = ["packages", "coding-agent", "src", "core", "file-lock.ts"].join("/");
const SOURCE_EXTENSION = /\.(?:[cm]?ts|[cm]?js|tsx)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".git"]);

function sourceFiles(directory: string, insideSrc: boolean): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(path, insideSrc || entry.name === "src"));
		} else if (insideSrc && SOURCE_EXTENSION.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function directAsyncLockCalls(source: string): string[] {
	const code = withoutComments(source);
	const findings: string[] = [];
	const bindings = [...code.matchAll(/import\s+(?:\*\s+as\s+)?(\w+)\s+from\s+["']proper-lockfile["']/g)].map(
		(match) => match[1],
	);
	for (const binding of bindings) {
		if (new RegExp(`\\b${binding}\\.lock\\s*\\(`).test(code)) findings.push(`${binding}.lock(`);
	}
	for (const match of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']proper-lockfile["']/g)) {
		if (/(^|[\s,])lock(\s+as\s+\w+)?\s*(,|$)/.test(match[1] ?? "")) findings.push("named import of lock");
	}
	if (/require\(\s*["']proper-lockfile["']\s*\)\.lock\s*\(/.test(code)) findings.push("require(...).lock(");
	return findings;
}

describe("proper-lockfile call-site guard", () => {
	it("detects each direct async lock shape", () => {
		expect(directAsyncLockCalls('import lockfile from "proper-lockfile";\nawait lockfile.lock(p);')).toHaveLength(1);
		expect(directAsyncLockCalls('import * as pl from "proper-lockfile";\nawait pl.lock(p);')).toHaveLength(1);
		expect(directAsyncLockCalls('import { lock, check } from "proper-lockfile";')).toHaveLength(1);
		expect(directAsyncLockCalls('await require("proper-lockfile").lock(p);')).toHaveLength(1);
		expect(directAsyncLockCalls('import lockfile from "proper-lockfile";\nlockfile.lockSync(p);')).toEqual([]);
		expect(directAsyncLockCalls('import lockfile from "proper-lockfile";\n// lockfile.lock(p)')).toEqual([]);
	});

	it("allows no direct lockfile.lock( outside core/file-lock.ts in packages/*/src", () => {
		const offenders = sourceFiles(join(repoRoot, "packages"), false)
			.map((path) => ({
				path: relative(repoRoot, path).split(sep).join("/"),
				calls: directAsyncLockCalls(readFileSync(path, "utf8")),
			}))
			.filter(({ path, calls }) => path !== helperPath && calls.length > 0);
		expect(offenders).toEqual([]);
	});
});
