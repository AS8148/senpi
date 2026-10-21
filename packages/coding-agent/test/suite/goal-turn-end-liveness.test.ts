import { describe, expect, it } from "vitest";
import {
	evaluateTurnEndLiveness,
	type TurnEndLivenessInput,
} from "../../src/core/extensions/builtin/goal/turn-end-liveness.ts";

function input(overrides: Partial<TurnEndLivenessInput> = {}): TurnEndLivenessInput {
	return {
		attended: true,
		isChildSession: false,
		mode: "tui",
		endedBy: "clean",
		deadlineStop: false,
		goalStopped: false,
		openWork: { kind: "active-goal", goalId: "goal-1" },
		continuationQueued: undefined,
		expectations: [],
		budgetSpent: false,
		providerRetryAtMs: undefined,
		...overrides,
	};
}

describe("evaluateTurnEndLiveness (#3863)", () => {
	it("reports a queued goal continuation as continuing", () => {
		expect(evaluateTurnEndLiveness(input({ continuationQueued: "goal" }))).toEqual({
			kind: "continuing",
			via: "goal",
		});
	});

	it("reports a delivered todo nudge as continuing", () => {
		expect(
			evaluateTurnEndLiveness(
				input({ openWork: { kind: "open-todos", count: 2 }, continuationQueued: "todo-backstop" }),
			),
		).toEqual({ kind: "continuing", via: "todo-backstop" });
	});

	it.each([
		["a running child", { kind: "wake-source", source: "senpi-task" }],
		["a live monitor", { kind: "wake-source", source: "terminal-monitors" }],
		["an armed backstop timer", { kind: "armed-timer", timer: "monitor" }],
		["a staged provider recovery", { kind: "recovery-staged" }],
		["a queued message", { kind: "pending-messages" }],
		["an open question to the user", { kind: "question-to-user" }],
	] as const)("waits on %s", (_label, expectation) => {
		expect(evaluateTurnEndLiveness(input({ expectations: [expectation] }))).toEqual({
			kind: "waiting",
			on: [expectation],
		});
	});

	it("is done when no work is open and nothing will re-enter", () => {
		expect(evaluateTurnEndLiveness(input({ openWork: { kind: "none" } }))).toEqual({ kind: "done" });
	});

	it("is stalled with no wake when work is open and nothing will re-enter", () => {
		expect(evaluateTurnEndLiveness(input({ openWork: { kind: "open-todos", count: 1 } }))).toEqual({
			kind: "stalled",
			reason: "no-wake",
		});
	});

	it("is stalled on budget when a guard refused to continue open work", () => {
		expect(evaluateTurnEndLiveness(input({ budgetSpent: true }))).toEqual({ kind: "stalled", reason: "budget" });
	});

	it("records the reset time for a provider-error stall, even with no open work", () => {
		expect(
			evaluateTurnEndLiveness(
				input({ openWork: { kind: "none" }, endedBy: "provider-error", providerRetryAtMs: 1_800_000 }),
			),
		).toEqual({ kind: "stalled", reason: "provider-error", retryAtMs: 1_800_000 });
		expect(evaluateTurnEndLiveness(input({ endedBy: "provider-error" }))).toEqual({
			kind: "stalled",
			reason: "provider-error",
		});
	});

	it.each([
		["unattended", { attended: false }],
		["user-abort", { endedBy: "user-abort" }],
		["child-session", { isChildSession: true }],
		["non-interactive", { mode: "print" }],
		["non-interactive", { mode: "json" }],
		["deadline-stop", { deadlineStop: true }],
		["goal-stopped", { goalStopped: true }],
	] as const)("holds (%s) open work that nothing re-enters", (reason, overrides) => {
		expect(evaluateTurnEndLiveness(input(overrides))).toEqual({ kind: "held", reason });
	});

	it("holds an unattended session even while its wake sources are live", () => {
		expect(
			evaluateTurnEndLiveness(
				input({ attended: false, expectations: [{ kind: "wake-source", source: "terminal-monitors" }] }),
			),
		).toEqual({ kind: "held", reason: "unattended" });
	});

	it("never reports a continuation that a lane queued as held", () => {
		expect(evaluateTurnEndLiveness(input({ isChildSession: true, continuationQueued: "goal" }))).toEqual({
			kind: "continuing",
			via: "goal",
		});
	});
});
