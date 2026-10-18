// senpi#3566 todo 4 (Windows half): the breakaway launch against the real kernel32 (runs in the Windows CI job under
// Bun; skipped with a reason elsewhere, and the CI job refuses a skip).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKernel32Process, startBreakaway } from "./windows-breakaway.ts";

const kernel = loadKernel32Process();
const reason = process.platform !== "win32" ? "not win32" : kernel === undefined ? "bun:ffi unavailable" : undefined;

const HARD_ARGUMENTS = [
	"plain",
	"",
	"with space",
	"tab\there",
	'a"quote',
	"trailing\\",
	"trailing space \\",
	"C:\\Program Files\\x\\",
	'back\\"slash-quote',
	"unicode é ✓",
];

describe.skipIf(reason !== undefined)(`breakaway launch on kernel32${reason ? ` (skipped: ${reason})` : ""}`, () => {
	it("starts a real command, reports its pid and returns its exit code", () => {
		if (kernel === undefined) throw new Error("unreachable");
		const command = startBreakaway(kernel, ["cmd.exe", "/d", "/c", "exit 3"]);
		expect(command.pid).toBeGreaterThan(0);
		expect(command.wait()).toBe(3);
	});

	it("round-trips hard arguments to a real process's argv", async () => {
		if (kernel === undefined) throw new Error("unreachable");
		const dir = await mkdtemp(join(tmpdir(), "tbw-"));
		try {
			const out = join(dir, "argv.json");
			const script = `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(-${HARD_ARGUMENTS.length})))`;
			const command = startBreakaway(kernel, [process.execPath, "-e", script, ...HARD_ARGUMENTS]);
			expect(command.wait()).toBe(0);
			expect(JSON.parse(await readFile(out, "utf8"))).toEqual(HARD_ARGUMENTS);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
