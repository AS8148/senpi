import { type ExtensionHandlerBudget, runBudgetedHandler } from "./handler-budget.ts";

/** A `session_move_export` / `session_move_import` handler that threw or was still running at the handler budget. */
export interface SessionMoveFailure {
	readonly extensionPath: string;
	readonly error: string;
	readonly stack?: string;
}

export interface SessionMoveHandlerCall {
	readonly extensionPath: string;
	readonly call: () => unknown;
}

/**
 * Runs every move handler, in order, each under `budget` (the `session_shutdown` handler budget), and returns every
 * failure. Unlike the ordinary emit, a failure is the caller's decision: a move's state would otherwise be lost.
 * A handler past the cap keeps running detached; the host stops waiting on it.
 */
export async function runSessionMoveHandlers(
	event: string,
	calls: readonly SessionMoveHandlerCall[],
	budget: ExtensionHandlerBudget,
): Promise<readonly SessionMoveFailure[]> {
	const failures: SessionMoveFailure[] = [];
	for (const { extensionPath, call } of calls) {
		const outcome = await runBudgetedHandler({ extensionPath, event, budget, run: () => call() });
		switch (outcome.kind) {
			case "settled":
				break;
			case "failed": {
				const { error } = outcome;
				failures.push({
					extensionPath,
					error: error instanceof Error ? error.message : String(error),
					...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
				});
				break;
			}
			case "timed_out":
				failures.push({ extensionPath, error: `handler timed out after ${budget.timeoutMs}ms` });
				break;
			case "released":
				failures.push({ extensionPath, error: "handler released before it finished" });
				break;
		}
	}
	return failures;
}
