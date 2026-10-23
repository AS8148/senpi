#!/usr/bin/env node
import assert from "node:assert/strict";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configDefaults } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const job = workflow.jobs["test-coding-agent"];
const indices = job.strategy.matrix.shard;
const command = job.steps.find((step) => step.name === "Test shard").run;
const count = Number(command.match(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/)[1]);
const root = fileURLToPath(new URL("../packages/coding-agent/", import.meta.url));
const files = globSync(configDefaults.include, {
	cwd: root,
	exclude: [...configDefaults.exclude, "test/manual-qa/**"],
}).map((file) => ({ moduleId: join(root, file) }));

const shard = (index, input = files) =>
	new BaseSequencer({ config: { root, shard: { index, count } } }).shard(input);

// senpi#4131: exercise the real Vitest partition used by the workflow, without running the suites.
test("the CI matrix schedules all four partitions with the existing timeout", () => {
	assert.deepEqual(indices, [1, 2, 3, 4]);
	assert.equal(count, indices.length);
	assert.equal(job["timeout-minutes"], 30);
	assert.equal(job.steps.find((step) => step.name === "Test shard")["timeout-minutes"], 25);
	assert.equal(workflow.jobs["check-and-test"].name, "Check and test");
	assert.ok(workflow.jobs["check-and-test"].needs.includes("test-coding-agent"));
});

test("every discovered coding-agent test belongs to exactly one scheduled shard", async () => {
	assert.ok(files.length > 0);
	const shards = await Promise.all(indices.map((index) => shard(index)));
	const assigned = shards.flat().map((file) => file.moduleId);
	assert.equal(assigned.length, files.length);
	assert.equal(new Set(assigned).size, files.length);
	assert.deepEqual(assigned.sort(), files.map((file) => file.moduleId).sort());
	const sizes = shards.map((part) => part.length);
	assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
});

test("shard membership is deterministic regardless of discovery order", async () => {
	for (const index of indices) {
		assert.deepEqual(await shard(index), await shard(index, [...files].reverse()));
	}
});

test("four shares of the recorded CI workload leave substantial test-step headroom", () => {
	// Successful runs 40013049077, 40012231014, 40010761161, 40010695252, 40008332498.
	// Seconds in the Test shard step, excluding setup. Dot logs have no per-file times:
	// this is an equal-cost capacity estimate, not a bound on actual shard duration.
	const observed = [
		[1378, 1130, 1019],
		[781, 1233, 1085],
		[1304, 1221, 854],
		[816, 1219, 1268],
		[1081, 831, 1307],
	];
	const predicted = Math.max(...observed.map((seconds) => seconds.reduce((a, b) => a + b, 0) / count));
	assert.ok(predicted < 16 * 60, `equal-share estimate ${predicted / 60} minutes leaves too little headroom`);
	console.log(`worst recorded equal-share estimate: ${(predicted / 60).toFixed(2)} minutes per shard`);
});
