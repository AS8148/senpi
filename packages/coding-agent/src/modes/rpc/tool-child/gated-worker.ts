/**
 * Job workers of a tool child (senpi#3566, plan todo 4). Heavy jobs and offloaded extension bodies run in workers so
 * the protocol loop stays free; `startGatedWorker` starts one with the barrier clock and routes its launch messages to
 * the gate, and `installWorkerBarrier` (first thing in the worker) gates `child_process`, the redirect extension imports
 * resolve to, and Bun's launch globals for every launch that worker makes.
 */
import realChildProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort, Worker, type WorkerOptions } from "node:worker_threads";
import { type BunLaunchGlobals, installGatedBun } from "./gated-bun.ts";
import { createGatedChildProcess } from "./gated-child-process.ts";
import { installChildProcessModule } from "./gated-modules.ts";
import type { LaunchGate } from "./launch-gate.ts";
import { readTestControls } from "./test-controls.ts";
import { WorkerLaunchClient, type WorkerLaunchMessage } from "./worker-launch.ts";

export interface GatedWorkerData {
	readonly barrierClock: SharedArrayBuffer;
	readonly jobId: string;
}

function isLaunchMessage(value: unknown): value is WorkerLaunchMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		(value.kind === "launch" || value.kind === "invoking" || value.kind === "done")
	);
}

export function startGatedWorker(
	gate: LaunchGate,
	file: string | URL,
	jobId: string,
	options: Omit<WorkerOptions, "workerData"> & { readonly workerData?: Record<string, unknown> } = {},
): Worker {
	const workerData: GatedWorkerData & Record<string, unknown> = {
		...options.workerData,
		barrierClock: gate.clock.buffer,
		jobId,
	};
	const worker = new Worker(file, { ...options, workerData });
	worker.on("message", (message: unknown) => {
		if (isLaunchMessage(message)) gate.handleWorker(message);
	});
	return worker;
}

export function installWorkerBarrier(data: GatedWorkerData, env: NodeJS.ProcessEnv = process.env): WorkerLaunchClient {
	const port = parentPort;
	if (port === null) throw new Error("installWorkerBarrier runs only inside a tool-child worker");
	const client = new WorkerLaunchClient({
		clockBuffer: data.barrierClock,
		post: (message) => port.postMessage(message),
		jobId: () => data.jobId,
		skipAckWait: readTestControls(env).enabled("SKIP_ACK_WAIT"),
	});
	const gated = createGatedChildProcess(realChildProcess, client);
	installChildProcessModule(gated);
	for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
		Object.defineProperty(realChildProcess, name, {
			value: Reflect.get(gated, name),
			configurable: true,
			writable: true,
		});
	}
	// Node re-binds named ESM imports of the builtin to the patched functions only after this call (Bun never does;
	// there, extension code reaches the gated module through the importer's redirect).
	syncBuiltinESMExports();
	const bun: unknown = Reflect.get(globalThis, "Bun");
	if (isBunLaunchGlobals(bun)) installGatedBun(bun, client);
	return client;
}

function isBunLaunchGlobals(value: unknown): value is BunLaunchGlobals {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "spawn") === "function" &&
		typeof Reflect.get(value, "spawnSync") === "function" &&
		typeof Reflect.get(value, "$") === "function"
	);
}

/**
 * A worker entry beside the calling module, named by its source path: the built package ships `.js`, so the extension
 * follows the caller's own file. Keep the `"./x.ts"` literal - the single-writer audit follows it into the worker.
 */
export function siblingWorkerUrl(sourceSpecifier: string, callerUrl: string): URL {
	const extension = extname(fileURLToPath(callerUrl));
	return new URL(sourceSpecifier.replace(/\.ts$/, extension), callerUrl);
}
