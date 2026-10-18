// A file-backed module the tool child's `module` job runs (senpi#3566 todo 4): plain named imports, no barrier code.
import { execFileSync as runOnce, spawnSync } from "node:child_process";

export function whoAmI(args: { readonly code: number }): { pid: number; status: number | null } {
	return { pid: process.pid, status: spawnSync("sh", ["-c", `exit ${args.code}`]).status };
}

export const notAFunction = 1;

/** Launches `true` once through the gated child_process: one ledger entry per call. */
export function launchTrue(): { ok: true } {
	runOnce("true");
	return { ok: true };
}
