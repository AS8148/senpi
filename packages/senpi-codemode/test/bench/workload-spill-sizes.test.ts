import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sizesOfExisting } from "../../scripts/bench-scenarios-workload.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("output-spill sizes", () => {
	it("skips a file renamed away between listing and stat (the kernel ledger's <path>.<pid>.tmp)", async () => {
		const root = mkdtempSync(join(tmpdir(), "codemode-spill-"));
		roots.push(root);
		const spill = join(root, "spill.txt");
		writeFileSync(spill, "x".repeat(10));
		// Listed, then renamed by the kernel before the bench stats it (codemode-gate on main 46d15a1c93).
		const vanished = join(root, "kernels", "py-globals.json.4242.tmp");
		expect(await sizesOfExisting([spill, vanished])).toEqual([{ path: spill, size: 10 }]);
	});

	it("still fails on a stat error other than a missing file", async () => {
		await expect(sizesOfExisting(["\0bad"])).rejects.toThrow();
	});
});
