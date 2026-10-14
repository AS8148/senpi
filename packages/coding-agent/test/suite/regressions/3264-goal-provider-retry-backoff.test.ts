import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
} from "../goal-monitor-test-harness.ts";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function providerFailure(errorMessage: string) {
	return {
		type: "agent_end" as const,
		aborted: false,
		willRetry: false,
		messages: [{ ...cleanAssistantStop(), stopReason: "error" as const, errorMessage }],
	};
}

async function goalSession(thread: string) {
	const harness = createGoalHarness();
	const ctx = await makeGoalContext([], thread);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep going" }, undefined, undefined, ctx as ExtensionToolContext);
	const failTurn = async (errorMessage: string) => {
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_end", providerFailure(errorMessage), ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
	};
	return { ...harness, ctx, failTurn };
}

function armedTimers(emitted: readonly { channel: string; data: unknown }[]) {
	return emitted
		.filter((event) => event.channel === "goal_continuation_timer_state")
		.map((event) => event.data as { armed: boolean; kind: string; dueAtMs?: number })
		.filter((data) => data.armed);
}

describe("goal continuation backs off while the provider is down (senpi#3264)", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("retries the first failure at once, then waits instead of bursting", async () => {
		vi.useFakeTimers({ now: NOW });
		const { sent, events, failTurn } = await goalSession("thread-3264-backoff");

		await failTurn("server_error: upstream unavailable");
		expect(sent).toHaveLength(1);

		await failTurn("server_error: upstream unavailable");
		expect(sent).toHaveLength(1);
		expect(armedTimers(events.emitted).at(-1)).toMatchObject({ kind: "providerRetry", dueAtMs: NOW + 15_000 });

		await vi.advanceTimersByTimeAsync(15_000);
		expect(sent).toHaveLength(2);
	});

	it("never fires eight retries inside thirty seconds", async () => {
		vi.useFakeTimers({ now: NOW });
		const { sent, failTurn } = await goalSession("thread-3264-no-burst");

		for (let attempt = 0; attempt < 8; attempt++) {
			await failTurn("server_error: upstream unavailable");
			await vi.advanceTimersByTimeAsync(3_000);
		}

		expect(Date.now() - NOW).toBeLessThanOrEqual(30_000);
		expect(sent.length).toBeLessThanOrEqual(2);
	});

	it("wakes when the pool says an account frees up", async () => {
		vi.useFakeTimers({ now: NOW });
		const { sent, events, failTurn } = await goalSession("thread-3264-wake");
		const freesAt = NOW + 15 * 60_000;

		await failTurn(`All Anthropic Subscription accounts are blocked until ${new Date(freesAt).toISOString()}.`);

		expect(sent).toHaveLength(0);
		expect(armedTimers(events.emitted).at(-1)).toMatchObject({ kind: "providerRetry", dueAtMs: freesAt + 1_000 });
		await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
		expect(sent).toHaveLength(1);
	});
});
