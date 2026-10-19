import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { pinReleaseCommit, syncRemoteMainBeforePush } from "./release-git.mjs";

describe("release main synchronization", () => {
	it("merges a concurrently advanced remote main before pushing", () => {
		const commands = [];
		syncRemoteMainBeforePush(
			false,
			(command, args) => {
				commands.push([command, args]);
				if (args[0] === "merge-base") {
					throw new Error("remote main advanced");
				}
			},
			() => {},
			() => {},
		);

		assert.deepEqual(commands, [
			["git", ["fetch", "origin", "main"]],
			["git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]],
			["git", ["merge", "--no-edit", "origin/main"]],
		]);
	});

	it("does not create a merge when remote main is already included", () => {
		const commands = [];
		syncRemoteMainBeforePush(
			false,
			(command, args) => commands.push([command, args]),
			() => {},
			() => {},
		);

		assert.deepEqual(commands, [
			["git", ["fetch", "origin", "main"]],
			["git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]],
		]);
	});

	it("previews the fetch and conditional merge", () => {
		const previews = [];
		syncRemoteMainBeforePush(
			true,
			() => assert.fail("dry-run must not execute commands"),
			() => {},
			(message) => previews.push(message),
		);

		assert.deepEqual(previews, [
			"git fetch origin main",
			"git merge --no-edit origin/main (if remote main advanced)",
		]);
	});

	it("synchronizes remote main after the next-cycle commit and before either push", () => {
		const releaseSource = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
		const nextCycleCommit = releaseSource.indexOf('gitCommit("Add [Unreleased] section for next cycle"');
		const synchronize = releaseSource.indexOf("syncRemoteMainBeforePush(args.dryRun");
		const pushMain = releaseSource.indexOf('gitPush("main", args.dryRun');
		const pushTag = releaseSource.indexOf("gitPush(`v${version}`");

		const tag = releaseSource.indexOf("gitTag(version, args.dryRun)");
		assert.ok(nextCycleCommit > 0 && synchronize > 0 && pushMain > 0 && pushTag > 0 && tag > 0);
		// The tag is cut before main is synchronized, so a late main merge never reaches the tagged commit (senpi#2943).
		assert.ok(tag < synchronize);
		assert.ok(nextCycleCommit < synchronize);
		assert.ok(synchronize < pushMain);
		assert.ok(pushMain < pushTag);
	});
});

describe("pinned release commit (senpi#3609)", () => {
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const runIn = (cwd) => (bin, args) => {
		execFileSync(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
	};
	const quiet = () => {};

	function repoWithMovedMain() {
		const root = mkdtempSync(join(tmpdir(), "senpi-pin-"));
		const origin = join(root, "origin.git");
		const work = join(root, "work");
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
		execFileSync("git", ["clone", "-q", origin, work], { stdio: "ignore" });
		for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git(work, "config", key, value);
		writeFileSync(join(work, "a.txt"), "x\n");
		git(work, "add", "a.txt");
		git(work, "commit", "-q", "-m", "x");
		const pinned = git(work, "rev-parse", "HEAD");
		writeFileSync(join(work, "later.txt"), "merged after the pinned commit\n");
		git(work, "add", "later.txt");
		git(work, "commit", "-q", "-m", "later");
		git(work, "push", "-q", "origin", "HEAD:main");
		const later = git(work, "rev-parse", "HEAD");
		// The release job's checkout: a fresh clone at main's tip, the commit after the pinned one.
		const job = join(root, "job");
		execFileSync("git", ["clone", "-q", origin, job], { stdio: "ignore" });
		for (const [key, value] of [["user.name", "t"], ["user.email", "t@example.com"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) git(job, "config", key, value);
		return { root, job, pinned, later };
	}

	it("tags the requested commit even when main moved past it", () => {
		const { root, job, pinned, later } = repoWithMovedMain();
		try {
			pinReleaseCommit(pinned, false, runIn(job), quiet, quiet);
			assert.equal(git(job, "rev-parse", "HEAD"), pinned);
			assert.equal(git(job, "branch", "--show-current"), "main");
			// The release stamps, commits and tags, then synchronizes main before pushing (release.mjs order).
			writeFileSync(join(job, "VERSION"), "2026.10.19-9\n");
			git(job, "add", "VERSION");
			git(job, "commit", "-q", "-m", "release: v2026.10.19-9");
			git(job, "tag", "v2026.10.19-9");
			syncRemoteMainBeforePush(false, runIn(job), quiet, quiet);
			assert.equal(git(job, "rev-parse", "v2026.10.19-9^"), pinned);
			assert.throws(() => git(job, "cat-file", "-e", "v2026.10.19-9:later.txt"));
			// main still moves forward: the pushed branch contains the later merge.
			assert.equal(git(job, "merge-base", "--is-ancestor", later, "HEAD"), "");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a commit that main does not contain", () => {
		const { root, job } = repoWithMovedMain();
		try {
			const stray = git(job, "commit-tree", "-m", "stray", git(job, "rev-parse", "HEAD^{tree}"));
			assert.throws(() => pinReleaseCommit(stray, false, runIn(job), quiet, quiet), /not on main/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses anything but a full 40-character commit sha", () => {
		for (const bad of ["de7038a0ed", "main", "HEAD~1", ""]) {
			assert.throws(() => pinReleaseCommit(bad, false, () => assert.fail("must not run git"), quiet, quiet), /40-character/);
		}
	});

	it("previews the pin without running git", () => {
		const previews = [];
		pinReleaseCommit("a".repeat(40), true, () => assert.fail("dry-run must not execute commands"), quiet, (m) => previews.push(m));
		assert.deepEqual(previews, ["git fetch origin main", `git merge-base --is-ancestor ${"a".repeat(40)} origin/main`, `git checkout -B main ${"a".repeat(40)}`]);
	});
});
