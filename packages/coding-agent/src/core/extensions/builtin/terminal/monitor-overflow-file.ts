/**
 * Per-monitor overflow file: lines a paced persistent watch matched beyond what one wake carries.
 * The wake names this file, so no matched line is lost to the batch cap. It lives in the session's
 * terminal state dir (not the watch's own SENPI_MONITOR_STATE_DIR, which belongs to the command and
 * is removed when the watch ends, while the agent may still need to read the overflow), and is
 * bounded: past MONITOR_OVERFLOW_FILE_MAX_BYTES it rotates to one `.1` copy.
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { MONITOR_OVERFLOW_FILE_MAX_BYTES } from "./shared.ts";

export function monitorOverflowPath(terminalDir: string, monitorId: string): string {
	return join(terminalDir, "overflow", `${monitorId}.log`);
}

/** Append `lines` to the watch's overflow file and return its path. Throws on a filesystem error. */
export function appendMonitorOverflow(
	terminalDir: string,
	monitorId: string,
	lines: readonly string[],
	maxBytes = MONITOR_OVERFLOW_FILE_MAX_BYTES,
): string {
	const path = monitorOverflowPath(terminalDir, monitorId);
	mkdirSync(join(terminalDir, "overflow"), { recursive: true, mode: 0o700 });
	let size = 0;
	try {
		size = statSync(path).size;
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (size >= maxBytes) renameSync(path, `${path}.1`);
	appendFileSync(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
	return path;
}
