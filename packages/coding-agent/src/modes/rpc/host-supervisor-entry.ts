#!/usr/bin/env node
/**
 * The lifecycle supervisor's own program for bundled installs (senpi#3743).
 *
 * A bundled install used to start every supervisor through `cli.js --internal-rpc-host-supervisor`,
 * which evaluates `main()`'s whole static graph (builtin extensions, provider catalog, TUI) before it
 * reaches the route: ~70 MB resident per supervisor, and the desktop runs one per opened thread. The
 * build emits this module as `dist/bundle/host-supervisor.js`, a self-contained file holding only the
 * supervisor graph (`test/supervisor-import-graph.test.ts` keeps it that way).
 *
 * Run as a program, it performs the part of the CLI preamble a supervisor relied on, in the same order:
 * the cwd guard, the process title and agent markers, silenced process warnings, and the brand read
 * before it is scrubbed so the host child inherits the same environment as before. The argv keeps the
 * `--internal-rpc-host-supervisor` sentinel, so tools that recognise a supervisor by its command line
 * still do. Imported (the import-graph probe), it does nothing.
 */
import "../../valid-cwd.ts";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_NAME } from "../../config.ts";
import { brandProfile, scrubBrandFromEnvironment } from "../../core/brand.ts";
import { findInternalSupervisorArgs, parseSupervisorArgs, runHostSupervisor } from "./host-lifecycle.ts";
import { writeStderrLine } from "./host-supervisor-log.ts";

function isEntryScript(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(import.meta.url) === realpathSync(entry);
	} catch {
		return false;
	}
}

if (isEntryScript()) {
	process.title = APP_NAME;
	process.env.PI_CODING_AGENT = "true";
	process.env.AI_AGENT = APP_NAME;
	process.emitWarning = (() => {}) as typeof process.emitWarning;
	brandProfile();
	scrubBrandFromEnvironment();

	const supervisorArgs = findInternalSupervisorArgs(process.argv.slice(2));
	const launch = supervisorArgs ? parseSupervisorArgs(supervisorArgs) : undefined;
	if (!launch) {
		writeStderrLine("invalid internal RPC host supervisor arguments");
		process.exit(2);
	}
	await runHostSupervisor(launch);
}
