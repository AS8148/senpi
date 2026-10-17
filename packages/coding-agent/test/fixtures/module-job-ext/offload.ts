// A file-backed module the tool child's `module` job runs (senpi#3566 todo 4): plain named imports, no barrier code.
import { spawnSync } from "node:child_process";

export function whoAmI(args: { readonly code: number }): { pid: number; status: number | null } {
	return { pid: process.pid, status: spawnSync("sh", ["-c", `exit ${args.code}`]).status };
}

export const notAFunction = 1;
