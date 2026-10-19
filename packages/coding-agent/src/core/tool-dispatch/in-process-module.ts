/**
 * `ctx.offload` under the in-process runtime (senpi#3622): the registered module runs in this process with the same
 * host the tool child's worker builds. Code here cannot be stopped, so a module past its deadline keeps its locks and,
 * after a grace, is reported stuck; closing the session closes its runs.
 */
import { pathToFileURL } from "node:url";
import type { HostCallHandler } from "../../modes/rpc/tool-child/host-calls-server.ts";
import { OFFLOAD_MAX_MS } from "../../modes/rpc/tool-child/job-policy.ts";
import { inProcessHostCalls, settleNow } from "./in-process-host-calls.ts";
import { OffloadError } from "./offload.ts";
import type { ToolChildModuleJob } from "./tool-dispatcher.ts";

/** What `InProcessToolDispatcher` gives every in-process module run. */
export interface InProcessModuleRuntime {
	/** The session's host-call handler; unset, every host call fails `tool_runtime_unavailable`. */
	readonly hostCalls?: HostCallHandler;
	/** How long past its deadline a module may keep running before it is reported stuck (default 10 s). */
	readonly stuckGraceMs?: number;
	/** Told once when a module is stuck: it still holds its locks, and every waiter on them now fails fast. */
	readonly onStuck?: (notice: StuckModuleNotice) => void;
	/** The live runs; the dispatcher ends them all (cancelled, host calls refused, locks released) when the session is closed or replaced. */
	readonly live?: Set<InProcessRun>;
}

export interface StuckModuleNotice {
	readonly modulePath: string;
	readonly export: string;
	readonly deadlineMs: number;
	/** The files whose locks it still holds (as the module named them). */
	readonly files: readonly string[];
	/** What to show the user. */
	readonly notice: string;
}

/** A live in-process run, as the dispatcher sees it. */
export interface InProcessRun {
	/**
	 * The session is closed or replaced: the module is cancelled and every further host call it makes is refused
	 * (`host_call_session_closed`). Settles once its locks are released - when its body settles, at once if it is already
	 * stuck, or after the grace if it does not settle by then (it is then reported stuck).
	 */
	close(): Promise<void>;
}

const DEFAULT_STUCK_GRACE_MS = 10_000;

/**
 * The in-process path: imports the module and runs its export with `(args, host)`, awaited - the same host the tool
 * child's worker builds, its calls answered by the session's host-call handler. Its deadline is the child's (the
 * caller's value, at most `OFFLOAD_MAX_MS`). Code in this process cannot be stopped, so past the deadline the module
 * keeps its locks - releasing one could let a second writer interleave with a write still in flight - and after a grace
 * it is reported stuck: every waiter on its locks fails fast, until it finishes or the session is closed. The dynamic
 * import is the feature itself (a registered module is loaded on first use), the documented exception to top-level
 * imports.
 */
export async function runModuleInProcess(
	job: ToolChildModuleJob,
	signal: AbortSignal | undefined,
	runtime: InProcessModuleRuntime = {},
): Promise<unknown> {
	let namespace: Record<string, unknown>;
	try {
		namespace = await import(pathToFileURL(job.modulePath).href);
	} catch (error) {
		throw new OffloadError(
			"offload_module_unavailable",
			`${job.modulePath} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const target = namespace[job.export];
	if (typeof target !== "function")
		throw new OffloadError("offload_module_unavailable", `${job.modulePath} has no function export "${job.export}"`);
	const cancellation = new AbortController();
	const onAbort = () => cancellation.abort(signal?.reason);
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const calls = inProcessHostCalls(job, cancellation.signal, runtime.hostCalls);
	const run = settleNow(() => Reflect.apply(target, undefined, [job.args, calls.host]));
	const bodySettled = run.then(
		() => undefined,
		() => undefined,
	);
	const holder = `${job.modulePath}#${job.export}`;
	const deadlineMs = Math.min(job.deadlineMs ?? OFFLOAD_MAX_MS, OFFLOAD_MAX_MS);
	const graceMs = runtime.stuckGraceMs ?? DEFAULT_STUCK_GRACE_MS;
	let stuck = false;
	const reportStuck = (why: string): void => {
		if (stuck || calls.ended()) return;
		stuck = true;
		const held = calls.heldFiles();
		calls.markStuck(holder);
		runtime.onStuck?.({
			modulePath: job.modulePath,
			export: job.export,
			deadlineMs,
			files: held,
			notice: `The module ${holder} is stuck: ${why} and it is still running in this process, where it cannot be stopped.${held.length === 0 ? "" : ` Its lock on ${held.join(", ")} stays held, and every write waiting on ${held.length === 1 ? "that file" : "those files"} now fails until it finishes or the session is closed.`} Run untrusted or long-running modules with --tool-runtime child, where a stuck module is stopped.`,
		});
	};
	const disposable: InProcessRun = {
		close: async () => {
			calls.close();
			cancellation.abort();
			if (!stuck) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const graceOver = new Promise<"grace">((resolveGrace) => {
					timer = setTimeout(() => resolveGrace("grace"), graceMs);
				});
				const outcome = await Promise.race([bodySettled, graceOver]).finally(() => clearTimeout(timer));
				if (outcome === "grace") reportStuck(`its session was closed and it did not finish within ${graceMs} ms`);
			}
			// Settled, or stuck with a closed session: nothing is left to keep its locks for.
			calls.end();
			runtime.live?.delete(disposable);
		},
	};
	runtime.live?.add(disposable);
	// The job ends when the module's own body settles - never at the deadline: a lock the body still holds (its write
	// still running) is released only then, as on the child, so no second writer can interleave with it.
	void bodySettled.then(() => {
		calls.end();
		runtime.live?.delete(disposable);
	});
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<never>((_resolve, reject) => {
		deadline = setTimeout(() => {
			calls.stopAdmitting();
			cancellation.abort();
			const files = calls.heldFiles();
			reject(
				new OffloadError(
					"tool_child_deadline",
					`${job.modulePath}#${job.export} ran past ${deadlineMs} ms${files.length === 0 ? "" : `; it still holds the lock on ${files.join(", ")} until it finishes`}`,
				),
			);
			const grace = setTimeout(() => reportStuck(`it ran past its ${deadlineMs} ms deadline`), graceMs);
			grace.unref?.();
		}, deadlineMs);
		deadline.unref?.();
	});
	try {
		return await Promise.race([run, expired]);
	} finally {
		clearTimeout(deadline);
		signal?.removeEventListener("abort", onAbort);
	}
}
