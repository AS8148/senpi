// Turn-end liveness (#3863): names what happens after a turn end from the outcomes the goal lane and the
// todo-owed backstop produced. It never starts or suppresses a turn.

import type { AgentEndEvent, ExtensionMode } from "../../types.ts";
import { didAgentEndCleanly } from "./continuation.ts";
import type { DelayedContinuationKind } from "./monitor-continuation-types.ts";
import { didTerminalPolicyRejectionEndTurn, didTerminalProviderErrorEndTurn } from "./terminal-provider-error.ts";

export const TURN_END_LIVENESS_EVENT = "turn_end_liveness";
/** Durable entry appended only for a `stalled` verdict: the session's last readable resume point. */
export const TURN_END_LIVENESS_ENTRY_TYPE = "turn-end-liveness";

export type TurnEndKind = "clean" | "user-abort" | "system-abort" | "provider-error" | "policy-rejection";

/** Something that will re-enter the session by itself. */
export type WakeExpectation =
	| { readonly kind: "wake-source"; readonly source: string }
	| { readonly kind: "armed-timer"; readonly timer: DelayedContinuationKind }
	| { readonly kind: "recovery-staged" }
	| { readonly kind: "pending-messages" }
	| { readonly kind: "question-to-user" };

export type OpenWork =
	| { readonly kind: "active-goal"; readonly goalId: string }
	| { readonly kind: "open-todos"; readonly count: number }
	| { readonly kind: "none" };

export interface TurnEndLivenessInput {
	/** False when the session started with no client attached (senpi#3853); such a session is never continued. */
	readonly attended: boolean;
	readonly isChildSession: boolean;
	readonly mode: ExtensionMode;
	readonly endedBy: TurnEndKind;
	/** A turn-deadline stop is never auto-continued; it waits for user input. */
	readonly deadlineStop: boolean;
	/** Paused or blocked goal: it waits for a person by design. */
	readonly goalStopped: boolean;
	readonly openWork: OpenWork;
	/** The lane that queued a hidden continuation at this turn end, if any. */
	readonly continuationQueued: "goal" | "todo-backstop" | undefined;
	readonly expectations: readonly WakeExpectation[];
	/** An existing guard refused to continue: the goal's continuation stopped, or the todo chain hit its cap. */
	readonly budgetSpent: boolean;
	/** The earliest future instant the failed turn's error names (a usage-limit reset). */
	readonly providerRetryAtMs: number | undefined;
}

export type HeldReason =
	| "unattended"
	| "user-abort"
	| "child-session"
	| "non-interactive"
	| "deadline-stop"
	| "goal-stopped";

export type StalledReason = "budget" | "provider-error" | "no-wake";

export type TurnEndLivenessVerdict =
	| { readonly kind: "continuing"; readonly via: "goal" | "todo-backstop" }
	| { readonly kind: "held"; readonly reason: HeldReason }
	| { readonly kind: "waiting"; readonly on: readonly WakeExpectation[] }
	| { readonly kind: "done" }
	| { readonly kind: "stalled"; readonly reason: StalledReason; readonly retryAtMs?: number };

const NON_INTERACTIVE_MODES: ReadonlySet<ExtensionMode> = new Set(["print", "json"]);

export function classifyTurnEnd(event: AgentEndEvent): TurnEndKind {
	if (event.aborted === true && event.abortSource === "user") return "user-abort";
	if (event.aborted === true && event.abortSource === "system") return "system-abort";
	if (didTerminalPolicyRejectionEndTurn(event)) return "policy-rejection";
	if (didTerminalProviderErrorEndTurn(event)) return "provider-error";
	return didAgentEndCleanly(event.messages) ? "clean" : "provider-error";
}

/**
 * Order matters: a continuation that was actually queued is reported first, so the verdict never denies what
 * the lanes did; then the reasons nothing may continue on its own; then the sources that will re-enter; and only
 * then stalled versus done. An errored turn left its request unfinished, so it is never `done`.
 */
export function evaluateTurnEndLiveness(input: TurnEndLivenessInput): TurnEndLivenessVerdict {
	if (input.continuationQueued !== undefined) return { kind: "continuing", via: input.continuationQueued };
	const held = heldReason(input);
	if (held !== undefined) return { kind: "held", reason: held };
	if (input.expectations.length > 0) return { kind: "waiting", on: input.expectations };
	if (input.endedBy === "provider-error" || input.endedBy === "policy-rejection") {
		return input.providerRetryAtMs === undefined
			? { kind: "stalled", reason: "provider-error" }
			: { kind: "stalled", reason: "provider-error", retryAtMs: input.providerRetryAtMs };
	}
	if (input.openWork.kind === "none") return { kind: "done" };
	return { kind: "stalled", reason: input.budgetSpent ? "budget" : "no-wake" };
}

function heldReason(input: TurnEndLivenessInput): HeldReason | undefined {
	if (!input.attended) return "unattended";
	if (input.endedBy === "user-abort") return "user-abort";
	if (input.isChildSession) return "child-session";
	if (NON_INTERACTIVE_MODES.has(input.mode)) return "non-interactive";
	if (input.deadlineStop) return "deadline-stop";
	if (input.goalStopped) return "goal-stopped";
	return undefined;
}
