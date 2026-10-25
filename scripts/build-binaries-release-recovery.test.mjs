#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const awaitScript = fileURLToPath(
	new URL("./await-dispatched-run.sh", import.meta.url),
);
const cleanupScript = fileURLToPath(
	new URL("./release-draft-cleanup.sh", import.meta.url),
);
const workflow = readFileSync(
	new URL("../.github/workflows/build-binaries.yml", import.meta.url),
	"utf8",
);

const roots = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function fakeBin(name, body) {
	const root = mkdtempSync(join(tmpdir(), `senpi-4173-${name}-`));
	roots.push(root);
	const path = join(root, name);
	writeFileSync(
		path,
		`#!/usr/bin/env bash\nset -u\nLOG=${JSON.stringify(join(root, "calls.log"))}\n${body}\n`,
	);
	chmodSync(path, 0o755);
	return { path, root, calls: () => readCalls(join(root, "calls.log")) };
}

function readCalls(path) {
	try {
		return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** A fake `gh run view` that answers one "<status> <conclusion>" line per call, repeating the last. */
function fakeGhRunView(states) {
	const gh = fakeBin("gh", "");
	const statesFile = join(gh.root, "states");
	const counter = join(gh.root, "count");
	writeFileSync(statesFile, `${states.join("\n")}\n`);
	writeFileSync(counter, "0");
	writeFileSync(
		gh.path,
		`#!/usr/bin/env bash
set -u
echo "$*" >> ${JSON.stringify(join(gh.root, "calls.log"))}
n=$(cat ${JSON.stringify(counter)}); n=$((n + 1)); echo "$n" > ${JSON.stringify(counter)}
total=$(wc -l < ${JSON.stringify(statesFile)})
if [ "$n" -gt "$total" ]; then n=$total; fi
sed -n "\${n}p" ${JSON.stringify(statesFile)}
`,
	);
	return gh;
}

function run(script, env) {
	return spawnSync("bash", [script], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 30_000,
	});
}

describe("await-dispatched-run.sh (senpi#4173)", () => {
	it("keeps waiting through queued and in_progress, then exits 0 on success", () => {
		const gh = fakeGhRunView([
			"queued ",
			"queued ",
			"in_progress ",
			"completed success",
		]);
		const result = run(awaitScript, {
			GH_BIN: gh.path,
			RUN_ID: "42",
			AWAIT_INTERVAL: "0",
			AWAIT_MAX_SECONDS: "60",
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(gh.calls().length, 4);
		assert.ok(gh.calls().every((call) => call.startsWith("run view 42")));
		assert.match(result.stdout, /queued/);
		assert.match(result.stdout, /in_progress/);
	});

	it("exits 1 when the child run completes with a failure conclusion", () => {
		const gh = fakeGhRunView(["in_progress ", "completed failure"]);
		const result = run(awaitScript, {
			GH_BIN: gh.path,
			RUN_ID: "42",
			AWAIT_INTERVAL: "0",
			AWAIT_MAX_SECONDS: "60",
		});
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout + result.stderr, /failure/);
	});

	it("exits 1 with a clear message when the child never completes within AWAIT_MAX_SECONDS", () => {
		const gh = fakeGhRunView(["queued "]);
		const result = run(awaitScript, {
			GH_BIN: gh.path,
			RUN_ID: "42",
			AWAIT_INTERVAL: "1",
			AWAIT_MAX_SECONDS: "2",
		});
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(
			result.stdout + result.stderr,
			/did not complete within 2 seconds/,
		);
		assert.ok(gh.calls().length >= 2);
	});
});

describe("release-draft-cleanup.sh (senpi#4173)", () => {
	function fakeGhRelease() {
		return fakeBin(
			"gh",
			`echo "$*" >> "$LOG"
case "$1 $2" in
  "release view") echo true ;;
  "release delete") exit 0 ;;
  *) exit 2 ;;
esac`,
		);
	}

	it("keeps the draft and exits non-zero when npm already has the version", () => {
		const gh = fakeGhRelease();
		const npm = fakeBin("npm", `echo "$*" >> "$LOG"\necho 2026.10.24-1`);
		const result = run(cleanupScript, {
			GH_BIN: gh.path,
			NPM_BIN: npm.path,
			RELEASE_TAG: "v2026.10.24-1",
		});
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.ok(
			!gh.calls().some((call) => call.startsWith("release delete")),
			gh.calls().join("\n"),
		);
		assert.deepEqual(npm.calls(), [
			"view @code-yeongyu/senpi@2026.10.24-1 version",
		]);
		assert.match(
			result.stdout + result.stderr,
			/gh release edit v2026\.10\.24-1 --draft=false/,
		);
	});

	it("deletes the draft when npm does not have the version", () => {
		const gh = fakeGhRelease();
		const npm = fakeBin(
			"npm",
			`echo "$*" >> "$LOG"\necho "npm error code E404" >&2\nexit 1`,
		);
		const result = run(cleanupScript, {
			GH_BIN: gh.path,
			NPM_BIN: npm.path,
			RELEASE_TAG: "v2026.10.24-1",
		});
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.ok(
			gh.calls().includes("release delete v2026.10.24-1 --yes"),
			gh.calls().join("\n"),
		);
	});

	it("keeps the draft when the npm lookup itself fails", () => {
		const gh = fakeGhRelease();
		const npm = fakeBin("npm", `echo "npm error code ETIMEDOUT" >&2\nexit 1`);
		const result = run(cleanupScript, {
			GH_BIN: gh.path,
			NPM_BIN: npm.path,
			RELEASE_TAG: "v2026.10.24-1",
		});
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(
			result.stdout + result.stderr,
			/Could not determine whether npm has @code-yeongyu\/senpi@2026\.10\.24-1/,
		);
		assert.ok(
			!gh.calls().some((call) => call.startsWith("release delete")),
			gh.calls().join("\n"),
		);
	});
});

describe("build-binaries.yml release recovery wiring (senpi#4173)", () => {
	it("awaits and cleans up through the scripts instead of a 60 minute gh run watch", () => {
		assert.doesNotMatch(workflow, /timeout 3600 gh run watch/);
		assert.match(workflow, /bash scripts\/await-dispatched-run\.sh/);
		assert.match(workflow, /bash scripts\/release-draft-cleanup\.sh/);
		assert.match(workflow, /AWAIT_MAX_SECONDS:\s*["']?19800/);
		assert.match(workflow, /timeout-minutes:\s*360/);
	});
});
