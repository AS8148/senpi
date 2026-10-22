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

	it("biome-port/no-string-case-mismatch flags a case-changed string compared with a literal of the other case", () => {
		const source = [
			"declare const s: string;",
			'export const a = s.toUpperCase() === "abc";',
			'export const b = "Abc" !== s.toLowerCase();',
			'export const c = s.toUpperCase() === "ABC";',
			"",
		].join("\n");
		assert.deepEqual(flagged("case.ts", source, "no-string-case-mismatch"), ["2", "3"]);
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
