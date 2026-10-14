import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("extension runtime module stable path", () => {
	it("resolves to a path that does not change when the versioned runtime file moves", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-erm-stable-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const runtimeA = join(root, "runtime-a");
		const versionedFile = join(runtimeA, "extension-runtime-module.js");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(runtimeA, { recursive: true });
		writeFileSync(versionedFile, `export const metadata = () => "a";\n`);

		const { stableRuntimeModulePathForTest } = await import("../../../src/core/extensions/bun-extension-registry.ts");
		const first = stableRuntimeModulePathForTest(versionedFile, agentDir);
		const firstContent = readFileSync(first, "utf8");

		expect(first.startsWith(agentDir)).toBe(true);
		expect(first.startsWith(runtimeA)).toBe(false);

		writeFileSync(versionedFile, `export const metadata = () => "b";\n`);
		const second = stableRuntimeModulePathForTest(versionedFile, agentDir);
		expect(second).toBe(first);
		expect(readFileSync(second, "utf8")).not.toBe(firstContent);
	});
});
