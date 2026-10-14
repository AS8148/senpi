import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AgentDeadlineTracker,
	buildDeadlineStopNotice,
	type DeadlineSessionOwner,
	TURN_DEADLINE_GRACE_MS,
	type TurnDeadline,
} from "../../../src/core/turn-deadline.ts";

interface FakeOwner extends DeadlineSessionOwner {
	isRetryInFlight: boolean;
	isIdle: boolean;
	readonly stops: TurnDeadline[];
	readonly warnings: string[];
	bashAborts: number;
	settleAbort(): void;
}

function fakeOwner(options: { abortSettles: "never" | "on_bash_abort" }): FakeOwner {
	let settle: () => void = () => {};
	const owner: FakeOwner = {
		isRetryInFlight: false,
		isIdle: false,
		stops: [],
		warnings: [],
		bashAborts: 0,
		_recordDeadlineStop: (deadline) => owner.stops.push(deadline),
		abortTurnForDeadline: () =>
			new Promise<void>((resolve) => {
				settle = () => {
					owner.isIdle = true;
					resolve();
				};
			}),
		abortBash: () => {
			owner.bashAborts += 1;
			if (options.abortSettles === "on_bash_abort") settle();
		},
		_warnDeadline: (event) => owner.warnings.push(event),
		settleAbort: () => settle(),
	};
	return owner;
}

describe("turn deadline tracker (senpi#3227 review)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("kills tool process trees after the grace when the abort does not settle, and the turn then ends", async () => {
		const owner = fakeOwner({ abortSettles: "on_bash_abort" });
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(owner.stops).toEqual([{ kind: "inactivity", limitMs: 60_000, elapsedMs: 60_000 }]);
		expect(owner.bashAborts).toBe(0);

		await vi.advanceTimersByTimeAsync(TURN_DEADLINE_GRACE_MS);
		expect(owner.bashAborts).toBe(1);
		expect(owner.isIdle).toBe(true);
		expect(owner.warnings).toEqual([]);
	});

	it("reports a turn no abort can end instead of faking idle", async () => {
		const owner = fakeOwner({ abortSettles: "never" });
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();

		await vi.advanceTimersByTimeAsync(60_000 + 2 * TURN_DEADLINE_GRACE_MS);

		expect(owner.bashAborts).toBe(1);
		expect(owner.isIdle).toBe(false);
		expect(owner.warnings).toEqual(["turn_deadline_unsettled"]);
	});

	it("keeps the inactivity lease through a provider retry and fires once the retry is over", async () => {
		const owner = fakeOwner({ abortSettles: "never" });
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();
		owner.isRetryInFlight = true;

		await vi.advanceTimersByTimeAsync(60_000);
		expect(owner.stops).toEqual([]);

		owner.isRetryInFlight = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(owner.stops).toMatchObject([{ kind: "inactivity", elapsedMs: 120_000 }]);
	});

	it("applies the max-runtime cap even while a provider retry is in flight", async () => {
		const owner = fakeOwner({ abortSettles: "never" });
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 0, maxRuntimeMs: 300_000 }));
		tracker.arm();
		owner.isRetryInFlight = true;

		await vi.advanceTimersByTimeAsync(300_000);

		expect(owner.stops).toEqual([{ kind: "max_runtime", limitMs: 300_000, elapsedMs: 300_000 }]);
	});

	it("does not reset the max-runtime clock when input is steered into a live run", async () => {
		const owner = fakeOwner({ abortSettles: "never" });
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 0, maxRuntimeMs: 300_000 }));
		tracker.arm();
		await vi.advanceTimersByTimeAsync(200_000);

		tracker.clearHold();
		await vi.advanceTimersByTimeAsync(100_000);

		expect(owner.stops).toMatchObject([{ kind: "max_runtime", elapsedMs: 300_000 }]);
	});

	it("reports a failed stop-entry write instead of rejecting unhandled", async () => {
		const owner = fakeOwner({ abortSettles: "never" });
		owner._recordDeadlineStop = () => {
			throw new Error("session refused the write");
		};
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(owner.warnings).toEqual(["turn_deadline_record_failed"]);
	});

	it("shows a sub-minute limit in seconds", () => {
		expect(buildDeadlineStopNotice({ kind: "max_runtime", limitMs: 20_000, elapsedMs: 20_000 })).toMatch(/20 s/);
		expect(buildDeadlineStopNotice({ kind: "inactivity", limitMs: 3_600_000, elapsedMs: 3_600_000 })).toMatch(
			/60 min/,
		);
	});
});
