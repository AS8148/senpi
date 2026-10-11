#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./test-temp-guard.mjs", import.meta.url));
for (const location of ["pre-export temp", "system /tmp"]) {
	test(`the job guard rejects repo entries escaping to ${location} (#3064)`, {
		skip: location === "system /tmp" && process.platform === "win32",
	}, () => {
		const parent = mkdtempSync(join(tmpdir(), "senpi-system-guard-"));
		let escaped;
		try {
			const receipt = join(parent, "snapshot.json");
			const options = { env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent,
				GITHUB_ENV: join(parent, "github.env") }, encoding: "utf8", timeout: 10_000 };
			assert.equal(spawnSync(process.execPath, [guard, "snapshot", receipt, "--export-env"], options).status, 0);
			escaped = mkdtempSync(join(location === "system /tmp" ? "/tmp" : parent, "senpi-rpc-proof-"));
			mkdirSync(join(escaped, "tui"));
			const checked = spawnSync(process.execPath, [guard, "check", receipt], options);
			assert.equal(checked.status, 1, checked.stdout);
			assert.match(checked.stderr, /senpi-rpc-proof-/);
		} finally {
			if (escaped) rmSync(escaped, { recursive: true, force: true });
			rmSync(parent, { recursive: true, force: true });
		}
	});
}
