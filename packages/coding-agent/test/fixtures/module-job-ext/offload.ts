// A file-backed module the tool child's `module` job runs (senpi#3566 todo 4): plain named imports, no barrier code.
import { execFileSync as runOnce, spawnSync } from "node:child_process";
import { existsSync as markerExists, writeFileSync as writeMarker } from "node:fs";

export function whoAmI(args: { readonly code: number }): { pid: number; status: number | null } {
	return { pid: process.pid, status: spawnSync("sh", ["-c", `exit ${args.code}`]).status };
}

export const notAFunction = 1;

export async function sleepFor(args: { readonly ms: number }): Promise<{ slept: number }> {
	await new Promise((resolveSleep) => setTimeout(resolveSleep, args.ms));
	return { slept: args.ms };
}

/** Kills its tool child the first time (marker absent), succeeds after: a job lost to a child exit. */
export function dieOnce(args: { readonly marker: string }): { pid: number } {
	if (!markerExists(args.marker)) {
		writeMarker(args.marker, "died");
		process.kill(process.pid, "SIGKILL");
	}
	return { pid: process.pid };
}

/** Kills its tool child every time. */
export function dieAlways(): never {
	process.kill(process.pid, "SIGKILL");
	throw new Error("unreachable");
}

/** Launches `true` once through the gated child_process: one ledger entry per call. */
export function launchTrue(): { ok: true } {
	runOnce("true");
	return { ok: true };
}
