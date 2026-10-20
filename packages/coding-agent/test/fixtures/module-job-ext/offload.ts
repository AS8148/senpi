// A file-backed module the tool child's `module` job runs (senpi#3566 todo 4): plain named imports, no barrier code.
import { execFileSync as runOnce, spawn as spawnOwned, spawnSync } from "node:child_process";
import { existsSync as markerExists, writeFileSync as writeMarker } from "node:fs";
import { Worker as NestedWorker } from "node:worker_threads";

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

/** Tries to start a worker thread from a module job: returns the refusal code, or "started" if it was allowed. */
export async function startNestedWorker(): Promise<string> {
	try {
		const worker = new NestedWorker("export {}", { eval: true });
		await worker.terminate();
		return "started";
	} catch (error) {
		return String(Reflect.get(Object(error), "code") ?? error);
	}
}
