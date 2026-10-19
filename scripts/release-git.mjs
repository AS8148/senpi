export function syncRemoteMainBeforePush(dryRun, runCommand, log, dryRunLog) {
	if (dryRun) {
		dryRunLog("git fetch origin main");
		dryRunLog("git merge --no-edit origin/main (if remote main advanced)");
		return;
	}

	log("git fetch origin main");
	runCommand("git", ["fetch", "origin", "main"]);

	try {
		runCommand("git", ["merge-base", "--is-ancestor", "origin/main", "HEAD"]);
		log("remote main is already an ancestor of the release branch");
	} catch {
		log("git merge --no-edit origin/main");
		runCommand("git", ["merge", "--no-edit", "origin/main"]);
	}
}

/**
 * Release an exact commit instead of whatever main is at dispatch (senpi#3609). The commit must already be on main, so
 * a release never ships code main does not have. The release then stamps and tags on top of it; syncRemoteMainBeforePush
 * merges the newer main only after the tag, so later merges never reach the tagged tree.
 */
export function pinReleaseCommit(sha, dryRun, runCommand, log, dryRunLog) {
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		throw new Error(`--sha needs a full 40-character commit sha, got ${JSON.stringify(sha)}`);
	}
	const steps = [
		["fetch", "origin", "main"],
		["merge-base", "--is-ancestor", sha, "origin/main"],
		["checkout", "-B", "main", sha],
	];
	if (dryRun) {
		for (const args of steps) dryRunLog(`git ${args.join(" ")}`);
		return;
	}
	log("git fetch origin main");
	runCommand("git", steps[0]);
	try {
		runCommand("git", steps[1]);
	} catch (error) {
		throw new Error(`${sha.slice(0, 12)} is not on main; a release ships only commits main already contains`, { cause: error });
	}
	log(`releasing the pinned commit ${sha.slice(0, 12)} (main may have moved past it)`);
	runCommand("git", steps[2]);
}
