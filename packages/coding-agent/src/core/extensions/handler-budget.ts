/**
 * Host budget for one extension event handler (senpi#3650). `session_shutdown` and the agent lifecycle events the
 * session persists on its serial event queue share this one implementation: past `warnMs` the host reports the
 * handler as stalled, at `timeoutMs` it aborts the handler's signal and stops waiting (the handler keeps running
 * detached), and the turn deadline can release every wait still held. A value of 0 disables that limit.
 */
export interface ExtensionHandlerBudget {
	readonly warnMs: number;
	readonly timeoutMs: number;
}

export type ExtensionHandlerStallStage = "warn" | "timeout" | "released";

export interface ExtensionHandlerStall {
	readonly extensionPath: string;
	readonly event: string;
	readonly stage: ExtensionHandlerStallStage;
	readonly elapsedMs: number;
	readonly timeoutMs: number;
}

export type BudgetedHandlerOutcome<T> =
	| { readonly kind: "settled"; readonly value: T }
	| { readonly kind: "failed"; readonly error: unknown }
	| { readonly kind: "timed_out" }
	| { readonly kind: "released" };

export class HeldHandlerWaits {
	private readonly releases = new Set<() => void>();

	hold(release: () => void): () => void {
		this.releases.add(release);
		return () => this.releases.delete(release);
	}

	releaseAll(): number {
		const pending = [...this.releases];
		this.releases.clear();
		for (const release of pending) release();
		return pending.length;
	}
}

export const HANDLER_TIMED_OUT: unique symbol = Symbol("extension handler timed out");
export const HANDLER_RELEASED: unique symbol = Symbol("extension handler released");
export type HandlerGuardVerdict = typeof HANDLER_TIMED_OUT | typeof HANDLER_RELEASED;

/**
 * Guards a handler that is already running without adding a microtask hop when it settles in time: the caller awaits
 * the returned race exactly as it awaited the handler before, and timers are cleared on a side chain. Turn ownership
 * in the agent_end window depends on that timing (senpi#3351), so this path must not add `then`/`finally` links.
 */
export function guardRunningHandler(pending: unknown, options: Omit<BudgetedHandlerRun<unknown>, "run">): unknown {
	if (typeof (pending as { then?: unknown } | null | undefined)?.then !== "function") return pending;
	const running = pending as PromiseLike<unknown>;
	const { budget, extensionPath, event } = options;
	const now = options.now ?? Date.now;
	const startedAt = now();
	const stall = (stage: ExtensionHandlerStallStage): void =>
		options.onStall?.({ extensionPath, event, stage, elapsedMs: now() - startedAt, timeoutMs: budget.timeoutMs });
	let warnTimer: ReturnType<typeof setTimeout> | undefined;
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	let unhold: (() => void) | undefined;
	const cleanup = (): void => {
		clearTimeout(warnTimer);
		clearTimeout(capTimer);
		unhold?.();
	};
	const guard = new Promise<HandlerGuardVerdict>((resolve) => {
		const stop = (verdict: HandlerGuardVerdict): void => {
			cleanup();
			stall(verdict === HANDLER_TIMED_OUT ? "timeout" : "released");
			resolve(verdict);
		};
		if (budget.warnMs > 0) warnTimer = setTimeout(() => stall("warn"), budget.warnMs);
		if (budget.timeoutMs > 0) capTimer = setTimeout(() => stop(HANDLER_TIMED_OUT), budget.timeoutMs);
		unhold = options.held?.hold(() => stop(HANDLER_RELEASED));
	});
	running.then(cleanup, cleanup);
	return Promise.race([running, guard]);
}

export interface BudgetedHandlerRun<T> {
	readonly extensionPath: string;
	readonly event: string;
	readonly budget: ExtensionHandlerBudget;
	readonly run: (signal: AbortSignal) => Promise<T> | T;
	readonly held?: HeldHandlerWaits;
	readonly onStall?: (stall: ExtensionHandlerStall) => void;
	readonly now?: () => number;
}

export async function runBudgetedHandler<T>(options: BudgetedHandlerRun<T>): Promise<BudgetedHandlerOutcome<T>> {
	const { budget, extensionPath, event } = options;
	const now = options.now ?? Date.now;
	const controller = new AbortController();
	const startedAt = now();
	// The handler starts synchronously, as a direct call would: input it queues during agent_end must land before
	// the core's post-agent_end drain. Its outcome is captured before any race, so a late rejection after a timeout
	// is already handled.
	let started: Promise<T>;
	try {
		started = Promise.resolve(options.run(controller.signal));
	} catch (error) {
		started = Promise.reject(error);
	}
	const settled: Promise<BudgetedHandlerOutcome<T>> = started.then(
		(value): BudgetedHandlerOutcome<T> => ({ kind: "settled", value }),
		(error: unknown): BudgetedHandlerOutcome<T> => ({ kind: "failed", error }),
	);
	const stall = (stage: ExtensionHandlerStallStage): void =>
		options.onStall?.({ extensionPath, event, stage, elapsedMs: now() - startedAt, timeoutMs: budget.timeoutMs });

	if (budget.warnMs <= 0 && budget.timeoutMs <= 0 && options.held === undefined) return settled;

	let warnTimer: ReturnType<typeof setTimeout> | undefined;
	let capTimer: ReturnType<typeof setTimeout> | undefined;
	let unhold: (() => void) | undefined;
	try {
		const outcome = await new Promise<BudgetedHandlerOutcome<T>>((resolve) => {
			if (budget.warnMs > 0) warnTimer = setTimeout(() => stall("warn"), budget.warnMs);
			if (budget.timeoutMs > 0) capTimer = setTimeout(() => resolve({ kind: "timed_out" }), budget.timeoutMs);
			unhold = options.held?.hold(() => resolve({ kind: "released" }));
			void settled.then(resolve);
		});
		if (outcome.kind === "timed_out" || outcome.kind === "released") {
			controller.abort(new Error(`${event} handler ${outcome.kind === "timed_out" ? "timed out" : "released"}`));
			stall(outcome.kind === "timed_out" ? "timeout" : "released");
		}
		return outcome;
	} finally {
		clearTimeout(warnTimer);
		clearTimeout(capTimer);
		unhold?.();
	}
}
