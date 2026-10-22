import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seatDigest } from "../src/core/extensions/builtin/anthropic-subscription/seat-digest.ts";

const installs: string[] = [];
function install(): string {
	const directory = mkdtempSync(join(tmpdir(), "seat-digest-"));
	installs.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of installs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("anthropic-subscription seat digest (oh-my-openagent#10304)", () => {
	it("is stable within one install and differs across installs", () => {
		const first = install();
		const second = install();

		expect(seatDigest("primary", first)).toMatch(/^[0-9a-f]{8}$/);
		expect(seatDigest("primary", first)).toBe(seatDigest("primary", first));
		expect(seatDigest("secondary", first)).not.toBe(seatDigest("primary", first));
		expect(seatDigest("primary", second)).not.toBe(seatDigest("primary", first));
	});

	it("cannot be confirmed from a guessed slot name without the install's salt", () => {
		const directory = install();
		for (const guess of ["env", "env-2", "ambient", "someone@example.com"]) {
			const unsalted = createHash("sha256").update(guess).digest("hex").slice(0, 8);
			expect(seatDigest(guess, directory)).not.toBe(unsalted);
		}
	});

	it("creates the salt once, readable only by its owner", () => {
		const directory = install();
		seatDigest("primary", directory);
		const salt = join(directory, "anthropic-subscription", "seat-digest-salt");

		expect(statSync(salt).mode & 0o777).toBe(0o600);
		expect(statSync(salt).size).toBe(32);
	});

	it("never fails the caller when the salt cannot be stored, and stays salted", () => {
		const directory = install();
		writeFileSync(join(directory, "anthropic-subscription"), "not a directory");
		const digest = seatDigest("env", directory);

		expect(digest).toMatch(/^[0-9a-f]{8}$/);
		expect(digest).not.toBe(createHash("sha256").update("env").digest("hex").slice(0, 8));
	});
});
