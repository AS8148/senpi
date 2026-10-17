import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bunAvailable = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!bunAvailable)("reopened session heap under Bun (senpi#3519)", () => {
	it("does not hold the 40 MB of history before the latest compaction", () => {
		const run = spawnSync("bun", [join(import.meta.dirname, "fixtures/3519-reopen-heap.ts")], {
			encoding: "utf8",
			cwd: join(import.meta.dirname, "../.."),
			// A blocking spawn ignores vitest's timeout; bound it so a stuck bun fails instead of hanging.
			timeout: 60_000,
		});
		expect(run.status, run.stderr).toBe(0);
		const result = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}");
		expect(result).toMatchObject({ contextMessages: 3, entries: 20_003 });
		expect(result.retainedMb).toBeLessThan(8);
	}, 90_000);
});
