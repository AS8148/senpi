import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sanitizeString } from "../src/screen-text.ts";

// Retention contract (senpi#3170): every PTY chunk a terminal screen keeps for resize replay goes through
// sanitizeString, and a screen keeps up to 1,000,000 replay chars. A string built one character at a time
// stays a rope of per-character nodes (about 32 bytes per char under JSC), so one busy terminal held tens
// of MB of history alone. It runs under Bun because the long-lived hosts that grew run on Bun's JSC.
const screenTextPath = fileURLToPath(new URL("../src/screen-text.ts", import.meta.url));

describe("sanitizeString", () => {
	it("returns valid text unchanged and replaces lone surrogates", () => {
		const text = "row 1 \u001b[31mred\u001b[0m 한글 😀\r\n";
		expect(sanitizeString(text)).toBe(text);
		expect(sanitizeString("a\ud800b\udc00c\ud83d")).toBe("a\uFFFDb\uFFFDc\uFFFD");
		expect(sanitizeString("")).toBe("");
	});

	it("keeps retained replay chunks near one byte per char", () => {
		// Given: 200 PTY-sized chunks (~5k chars each), one of them carrying a lone surrogate.
		const output = execFileSync(
			"bun",
			[
				"--eval",
				`
import { heapStats } from "bun:jsc";
import { sanitizeString } from ${JSON.stringify(screenTextPath)};
const gc = () => { Bun.gc(true); Bun.gc(true); return heapStats().heapSize; };
const chunk = (k) => Array.from({ length: 64 }, (_, j) => "row " + k + "-" + j + " " + "z".repeat(60) + " fn" + j + "()\\r\\n").join("") + (k === 7 ? "\\ud800" : "");
const inputs = Array.from({ length: 200 }, (_, k) => Buffer.from(chunk(k)).toString());
const before = gc();
// When: the sanitized chunks are kept, as the screen's replay history keeps them.
const kept = inputs.map((input) => sanitizeString(input));
inputs.length = 0;
const after = gc();
const chars = kept.reduce((total, text) => total + text.length, 0);
console.log(JSON.stringify({ chars, bytesPerChar: (after - before) / chars }));
process.exit(0);
`,
			],
			{ encoding: "utf8", timeout: 60_000 },
		);
		const result = JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as { chars: number; bytesPerChar: number };
		// Then: the kept text costs about what flat strings cost, not a rope node per character.
		expect(result.chars).toBeGreaterThan(900_000);
		expect(result.bytesPerChar).toBeLessThan(4);
	});
});
