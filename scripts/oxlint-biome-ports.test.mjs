#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const dir = mkdtempSync(join(root, "packages", "coding-agent", "src", "oxlint-biome-ports-fixture-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const flagged = (name, source, rule) => {
	const file = join(dir, name);
	writeFileSync(file, source);
	const result = spawnSync(join(root, "node_modules", ".bin", "oxlint"), ["-c", ".oxlintrc.json", "-f", "unix", file], {
		cwd: root,
		encoding: "utf8",
		shell: process.platform === "win32",
	});
	return result.stdout
		.split("\n")
		.filter((line) => line.includes(`(${rule})`))
		.map((line) => line.split(":")[1] ?? "");
};

describe("Biome rules ported to oxlint", () => {
	it("biome-port/no-implicit-any-let flags an untyped let with no value (Biome noImplicitAnyLet)", () => {
		const source = "let a;\nlet b: string;\nlet c = 1;\nexport { a, b, c };\n";
		assert.deepEqual(flagged("let.ts", source, "no-implicit-any-let"), ["1"]);
	});

	it("biome-port/no-implicit-any-let also flags var and ambient declarations, and accepts loop variables, as Biome does", () => {
		const source = [
			"declare const xs: number[];",
			"declare const o: Record<string, number>;",
			"var v;",
			"for (let x of xs) void x;",
			"for (let k in o) void k;",
			"for (var y of xs) void y;",
			"declare let ambient;",
			"export { v, ambient };",
			"",
		].join("\n");
		assert.deepEqual(flagged("let-loops.ts", source, "no-implicit-any-let"), ["3", "7"]);
	});

	it("biome-port/no-string-case-mismatch flags a case-changed string compared with a literal of the other case on its right", () => {
		const source = [
			"declare const s: string;",
			'export const a = s.toUpperCase() === "abc";',
			'export const b = "Abc" !== s.toLowerCase();',
			'export const c = s.toUpperCase() === "ABC";',
			"",
		].join("\n");
		// Biome checks only the call-on-the-left form, so the literal-first comparison on line 3 passes.
		assert.deepEqual(flagged("case.ts", source, "no-string-case-mismatch"), ["2"]);
	});

	it("biome-port/no-string-case-mismatch also checks switch cases and template literals, as Biome does", () => {
		const source = [
			"declare const s: string;",
			"export const a = s.toUpperCase() === `abc`;",
			"export const b = s.toUpperCase() === `ABC`;",
			"switch (s.toLowerCase()) {",
			'\tcase "Abc":',
			"\t\tbreak;",
			'\tcase "abc":',
			"\t\tbreak;",
			"}",
			"",
		].join("\n");
		assert.deepEqual(flagged("case-more.ts", source, "no-string-case-mismatch"), ["2", "5"]);
	});

	it("senpi/model-type-comparison flags a direct comparison with the chat type", () => {
		const source = [
			"declare const model: { type?: string };",
			'export const a = model.type === "chat";',
			'export const b = "chat" != model.type;',
			'export const c = model.type === "image";',
			"",
		].join("\n");
		assert.deepEqual(flagged("model.ts", source, "model-type-comparison"), ["2", "3"]);
	});
});

describe("oxlint configuration", () => {
	it("enables no type-aware rule, because lint runs without --type-aware and would skip it silently", () => {
		const oxlint = join(root, "node_modules", ".bin", "oxlint");
		const run = (args) => {
			const result = spawnSync(oxlint, args, { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
			assert.equal(result.status, 0, result.stderr);
			return JSON.parse(result.stdout);
		};
		const typeAware = new Set(run(["--rules", "-f", "json"]).filter((rule) => rule.type_aware).map((rule) => `${rule.scope}/${rule.value}`));
		assert.ok(typeAware.size > 0, "oxlint --rules must list its type-aware rules");
		const level = (setting) => (Array.isArray(setting) ? setting[0] : setting);
		const enabled = Object.entries(run(["--print-config"]).rules)
			.filter(([name, setting]) => typeAware.has(name) && !["off", "allow", 0].includes(level(setting)))
			.map(([name]) => name);
		assert.deepEqual(enabled, []);
	});
});
