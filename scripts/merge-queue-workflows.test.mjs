#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const required = JSON.parse(readFileSync(new URL("../.github/required-checks.json", import.meta.url), "utf8"));

function workflow(file) {
	return parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
}

describe("merge queue: every required check also runs on merge_group", () => {
	it("lists the required checks", () => {
		assert.ok(required.checks.length > 0);
	});

	for (const check of required.checks) {
		describe(check.context, () => {
			const parsed = workflow(check.workflow);
			const job = parsed.jobs?.[check.job];

			it(`${check.workflow} triggers on merge_group checks_requested`, () => {
				assert.ok(parsed.on && typeof parsed.on === "object" && "merge_group" in parsed.on, `${check.workflow} has no merge_group trigger`);
				assert.deepEqual(parsed.on.merge_group, { types: ["checks_requested"] });
			});

			it(`job ${check.job} reports under the exact required name`, () => {
				assert.ok(job, `${check.workflow} has no job ${check.job}`);
				assert.equal(job.name, check.context);
			});

			it("is the only job in its workflow that reports under that name", () => {
				const named = Object.entries(parsed.jobs).filter(([, other]) => other.name === check.context);
				assert.deepEqual(named.map(([id]) => id), [check.job]);
			});

			it("is not skipped on merge_group by an event filter", () => {
				const condition = String(job?.if ?? "");
				if (!/github\.event_name/.test(condition)) return;
				assert.match(condition, /github\.event_name == 'merge_group'/, `${check.job} filters events but omits merge_group, so the queue would see it skipped`);
			});
		});
	}
});

describe("Changelog gate on merge_group", () => {
	const job = workflow("changelog-gate.yml").jobs["changelog-gate"];
	const step = (name) => job.steps.find((candidate) => candidate.name === name);

	it("checks out the queue commit when there is no pull request", () => {
		assert.equal(step("Checkout").with.ref, "${{ github.event.pull_request.head.sha || github.sha }}");
	});

	it("runs the PR-metadata check only for pull requests", () => {
		assert.equal(step("Check PR changelog and changes.md coverage").if, "github.event_name == 'pull_request'");
	});

	it("still runs the whole-tree changes.md audit on the queue commit", () => {
		assert.equal(step("Audit changes.md coverage against the upstream pin").if, undefined);
	});
});

describe("Review claim gate on merge_group", () => {
	const script = workflow("review-claims.yml").jobs.gate.steps[0].with.script;

	it("finds the queued pull request from the merge group head ref", () => {
		assert.match(script, /context\.payload\.merge_group\?\.head_ref/);
		const queued = /\/pr-(\d+)-[0-9a-f]+$/.exec("refs/heads/gh-readonly-queue/main/pr-3169-b07fa24074c8fe7317ebec4a2ef1ba74272aab49");
		assert.equal(queued?.[1], "3169");
	});

	it("fails closed when it cannot tell which pull request the run is for", () => {
		assert.match(script, /core\.setFailed\("Merge blocked: could not tell which pull request this run is for\."\)/);
	});
});
