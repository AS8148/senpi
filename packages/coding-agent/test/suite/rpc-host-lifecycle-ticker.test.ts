import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupervisorActivity, SupervisorOwner } from "../../src/modes/rpc/host-lifecycle-activity.ts";
import { DEFAULT_HOST_IDLE_EXIT_MS } from "../../src/modes/rpc/host-lifecycle-policy.ts";
import { SUPERVISOR_TICK_MAX_MS, startSupervisorTicker } from "../../src/modes/rpc/host-lifecycle-ticker.ts";

// senpi#3747: one supervisor runs per desktop thread host, and each one checked its idle window and
// owner every second although the default window is minutes long.
function harness(idleExitMs: number) {
	let refreshes = 0;
	let ownerChecks = 0;
	const activity = {
		refresh: () => {
			refreshes += 1;
			return "stay";
		},
		clients: { unclassifiedCount: 0 },
	} as unknown as SupervisorActivity;
	const owner = {
		shouldExit: async () => {
			ownerChecks += 1;
			return false;
		},
		stop: () => {},
	} as unknown as SupervisorOwner;
	const stop = startSupervisorTicker({
		idleExitMs,
		activity,
		owner,
		draining: () => false,
		shuttingDown: () => false,
		shutdown: () => new Promise<never>(() => {}),
	});
	return { stop, refreshes: () => refreshes, ownerChecks: () => ownerChecks };
}

describe("supervisor idle/owner ticker", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("checks at most every 5 s under the default idle window", async () => {
		vi.useFakeTimers();
		const ticker = harness(DEFAULT_HOST_IDLE_EXIT_MS);
		try {
			await vi.advanceTimersByTimeAsync(20_000);
			expect(ticker.refreshes()).toBe(20_000 / SUPERVISOR_TICK_MAX_MS);
			expect(ticker.ownerChecks()).toBe(20_000 / SUPERVISOR_TICK_MAX_MS);
		} finally {
			ticker.stop();
		}
	});

	it("still checks four times per window when the idle window is short", async () => {
		vi.useFakeTimers();
		const ticker = harness(2_000);
		try {
			await vi.advanceTimersByTimeAsync(2_000);
			expect(ticker.refreshes()).toBe(4);
		} finally {
			ticker.stop();
		}
	});
});
