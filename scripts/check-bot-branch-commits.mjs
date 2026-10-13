#!/usr/bin/env node
// Refuses a generated-data automation branch that carries commits the bot did not write (#3243).
// A hand merge of main into automation/opengateway-catalog-refresh kept the branch's older catalog
// snapshot over newer data on main; the branch must only ever hold the bot's regeneration.
import { execFileSync } from "node:child_process";

export function foreignCommits({ cwd, base, head, botEmail }) {
	const log = execFileSync("git", ["log", "--format=%H%x09%ae%x09%s", `${base}..${head}`], {
		cwd,
		encoding: "utf8",
	});
	return log
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha, email, ...subject] = line.split("\t");
			return { sha, email, subject: subject.join("\t") };
		})
		.filter((commit) => commit.email !== botEmail);
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i]?.replace(/^--/, "");
		const value = argv[i + 1];
		if (!key || value === undefined) throw new Error(`usage: --base <ref> --head <ref> --bot-email <email>`);
		args[key] = value;
	}
	for (const required of ["base", "head", "bot-email"]) {
		if (!args[required]) throw new Error(`missing --${required}`);
	}
	return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const args = parseArgs(process.argv.slice(2));
	const foreign = foreignCommits({
		cwd: process.cwd(),
		base: args.base,
		head: args.head,
		botEmail: args["bot-email"],
	});
	if (foreign.length > 0) {
		console.error(
			`Refusing ${args.head}: it carries ${foreign.length} commit(s) not written by ${args["bot-email"]}. ` +
				"An automation branch must hold only the bot's regeneration; close the PR and let the workflow regenerate from main.",
		);
		for (const commit of foreign) console.error(`  ${commit.sha.slice(0, 10)} ${commit.email} ${commit.subject}`);
		process.exit(1);
	}
	console.log(`${args.head}: only ${args["bot-email"]} commits since ${args.base}.`);
}
