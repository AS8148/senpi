// A file-backed module the tool child's `module` job runs (senpi#3566 todo 4): plain named imports, no barrier code.
import { execFileSync as runOnce, spawn as spawnOwned, spawnSync } from "node:child_process";
import { writeFileSync as writeMarker } from "node:fs";

export function whoAmI(args: { readonly code: number }): { pid: number; status: number | null } {
	return { pid: process.pid, status: spawnSync("sh", ["-c", `exit ${args.code}`]).status };
}

export const notAFunction = 1;

/** Launches `true` once through the gated child_process: one ledger entry per call. */
export function launchTrue(): { ok: true } {
	runOnce("true");
	return { ok: true };
}

/** Settles only when the job is cancelled: proves the cancel reaches the body as an aborted signal. */
export function waitForCancel(_args: unknown, context: { readonly signal: AbortSignal }): Promise<{ aborted: true }> {
	return new Promise((resolveCancel) =>
		context.signal.addEventListener("abort", () => resolveCancel({ aborted: true }), { once: true }),
	);
}

/** Starts an owned own-group sleep (reporting its pid through a marker file), then never settles. */
export function ownedSleepThenHang(args: { readonly marker: string }): Promise<never> {
	const child = spawnOwned("/bin/sleep", ["300"], { stdio: "ignore" });
	writeMarker(args.marker, String(child.pid));
	return new Promise(() => {});
}
