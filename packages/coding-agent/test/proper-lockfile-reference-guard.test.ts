import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Two source gates for proper-lockfile (oh-my-openagent#10878):
// 1. Only core/file-lock.ts may reference the package. Its async lock gets the dependency's default
//    onCompromised, which throws from a heartbeat timer and kills the process on a release race.
//    The only other references allowed are the listed lockSync-only files (no heartbeat), and
//    there the default-import binding may be used only as `<binding>.lockSync/unlockSync/checkSync(`.
// 2. A holder that lost a live lock must stop: every lockWithLossHandling( call passes onLost, or
//    its file is listed below with the reason and the file whose assertHeld() guards its writes.

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const SRC = "packages/coding-agent/src";
const HELPER = `${SRC}/core/file-lock.ts`;

const LOCK_SYNC_ONLY = new Set([
	`${SRC}/core/auth-storage.ts`,
	`${SRC}/core/settings-manager.ts`,
	`${SRC}/core/trust-manager.ts`,
	`${SRC}/core/extensions/builtin/hooks/trust-storage.ts`,
	`${SRC}/package-manager-cli.ts`,
]);

const STOPS_AT_ASSERT_HELD: Record<string, { reason: string; assertedIn: string }> = {
	[`${SRC}/core/extensions/builtin/mcp/catalog-cache.ts`]: {
		reason: "best-effort cache; the atomic rename is skipped once the lock is lost",
		assertedIn: `${SRC}/core/extensions/builtin/mcp/catalog-cache.ts`,
	},
	[`${SRC}/core/credential-pool/state-file.ts`]: {
		reason: "one short read-modify-write; the store asserts before writing the state file",
		assertedIn: `${SRC}/core/credential-pool/state-store.ts`,
	},
	[`${SRC}/core/extensions/builtin/mcp/auth/token-store.ts`]: {
		reason: "update, clear and writeUnlocked (the OAuth refresh commit) assert before writing",
		assertedIn: `${SRC}/core/extensions/builtin/mcp/auth/token-store.ts`,
	},
	[`${SRC}/core/session-move/move-ledger.ts`]: {
		reason: "every record write asserts before its rename",
		assertedIn: `${SRC}/core/session-move/move-ledger.ts`,
	},
	[`${SRC}/core/settings-manager.ts`]: {
		reason: "the settings publish asserts before its rename",
		assertedIn: `${SRC}/core/settings-manager.ts`,
	},
	[`${SRC}/experimental/server.ts`]: {
		reason: "launcher and activation abort their operation at assertHeld checkpoints",
		assertedIn: `${SRC}/experimental/server.ts`,
	},
	[`${SRC}/package-manager-cli.ts`]: {
		reason: "the update aborts before the release rename and before activation",
		assertedIn: `${SRC}/package-manager-cli.ts`,
	},
};

const SOURCE_EXTENSION = /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/;
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

/** Blanks comments while keeping string contents, so a module name inside a string is still seen. */
function withoutComments(source: string): string {
	let out = "";
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		const next = source[i + 1];
		if (char === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
		} else if (char === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			out += " ";
		} else if (char === '"' || char === "'" || char === "`") {
			const start = i++;
			while (i < source.length && source[i] !== char) i += source[i] === "\\" ? 2 : 1;
			out += source.slice(start, ++i);
		} else {
			out += char;
			i++;
		}
	}
	return out;
}

const SYNC_ONLY_IMPORT = /^\s*import\s+(\w+)\s+from\s+["']proper-lockfile["'];?\s*$/m;

function referenceViolations(path: string, source: string): string[] {
	const code = withoutComments(source);
	if (!code.includes("proper-lockfile") || path === HELPER) return [];
	if (!LOCK_SYNC_ONLY.has(path)) return ["references proper-lockfile"];
	const [importLine, binding] = code.match(SYNC_ONLY_IMPORT) ?? [];
	if (!importLine || !binding) return ["lockSync-only file must use one plain default import"];
	const rest = code.replace(importLine, "");
	if (rest.includes("proper-lockfile")) return ["second proper-lockfile reference"];
	const uses = [
		...rest.matchAll(new RegExp(`(?<![\\w.$/-])${binding}\\b(?![-.]\\w*\\.ts)(\\s*\\.\\s*\\w+\\s*\\()?`, "g")),
	];
	return uses
		.filter(([, call]) => !call || !/^\s*\.\s*(lockSync|unlockSync|checkSync)\s*\($/.test(call))
		.map(([use]) => `non-sync use: ${use.trim()}`);
}

function callArguments(code: string, openParen: number): string {
	let depth = 0;
	for (let i = openParen; i < code.length; i++) {
		if (code[i] === "(") depth++;
		else if (code[i] === ")" && --depth === 0) return code.slice(openParen + 1, i);
	}
	return code.slice(openParen + 1);
}

function lockCallsWithoutOnLost(source: string): number {
	const code = withoutComments(source);
	return [...code.matchAll(/\blockWithLossHandling\s*\(/g)].filter(
		(match) => !/\bonLost\b/.test(callArguments(code, (match.index ?? 0) + match[0].length - 1)),
	).length;
}

const relativePath = (path: string) => relative(repoRoot, path).split(sep).join("/");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("proper-lockfile reference guard", () => {
	it("rejects every way to reach the async lock outside the helper", () => {
		const offender = `${SRC}/core/example.ts`;
		for (const shape of [
			'import lockfile from "proper-lockfile";',
			'import * as pl from "proper-lockfile";',
			'import lockfile, { lock } from "proper-lockfile";',
			'import type { LockOptions } from "proper-lockfile";',
			'const pl = require("proper-lockfile");',
			'const { lock } = require("proper-lockfile");',
			'const pl = createRequire(import.meta.url)("proper-lockfile");',
			'const pl = await import("proper-lockfile");',
			'const url = "https://x"; const pl = require("proper-lockfile");',
		]) {
			expect(referenceViolations(offender, shape), shape).not.toEqual([]);
		}
		expect(referenceViolations(offender, "// see proper-lockfile\n/* proper-lockfile */ const a = 1;")).toEqual([]);
	});

	it("allows a lockSync-only file only the sync calls on its default import", () => {
		const syncFile = `${SRC}/core/trust-manager.ts`;
		const head = 'import lockfile from "proper-lockfile";\n';
		expect(
			referenceViolations(
				syncFile,
				`${head}import { x } from "./lockfile-policy.ts";\nlockfile.lockSync(p);\nlockfile.unlockSync(p);`,
			),
		).toEqual([]);
		for (const body of [
			"await lockfile.lock(p);",
			'await lockfile["lock"](p);',
			"const { lock } = lockfile;",
			"const alias = lockfile;",
			"run(lockfile);",
			'const pl = require("proper-lockfile");',
		]) {
			expect(referenceViolations(syncFile, `${head}${body}`), body).not.toEqual([]);
		}
		expect(referenceViolations(syncFile, 'import lockfile, { lock } from "proper-lockfile";')).not.toEqual([]);
	});

	it("finds lock calls that pass no onLost", () => {
		expect(lockCallsWithoutOnLost("await lockWithLossHandling(p, { stale: 1, onLost: stop });")).toBe(0);
		expect(lockCallsWithoutOnLost("await lockWithLossHandling(p, { stale: f(1) });")).toBe(1);
		expect(lockCallsWithoutOnLost("await lockWithLossHandling(p, { ...opts }); // onLost")).toBe(1);
	});

	it("no file under packages/*/src references proper-lockfile except the helper and the lockSync-only files", () => {
		const offenders = sourceFiles(join(repoRoot, "packages"), false)
			.map((path) => ({
				path: relativePath(path),
				problems: referenceViolations(relativePath(path), readFileSync(path, "utf8")),
			}))
			.filter(({ problems }) => problems.length > 0);
		expect(offenders).toEqual([]);
	});

	it("every lock site passes onLost or is a listed site whose writes call assertHeld()", () => {
		const unlisted = sourceFiles(join(repoRoot, "packages"), false)
			.map(relativePath)
			.filter(
				(path) => path !== HELPER && lockCallsWithoutOnLost(read(path)) > 0 && !(path in STOPS_AT_ASSERT_HELD),
			);
		expect(unlisted).toEqual([]);
		for (const [path, { assertedIn }] of Object.entries(STOPS_AT_ASSERT_HELD)) {
			expect(lockCallsWithoutOnLost(read(path)), `${path} no longer needs its allowlist entry`).toBeGreaterThan(0);
			expect(withoutComments(read(assertedIn)), assertedIn).toMatch(/\bassertHeld(?:\?\.)?\(\)/);
		}
	});
});
