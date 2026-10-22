import { describe, expect, it } from "vitest";
import {
	type MonitorNotificationScheduler,
	MonitorNotifier,
	type MonitorSpillResult,
} from "../../src/core/extensions/builtin/terminal/monitor-notify.ts";
import { FakeScheduler, line } from "./terminal-monitor-notify-harness.ts";

const MAX_CHARS = 4096;

/** Counts every timer the notifier arms, so a test can tell a quiet wait from a flush storm. */
class CountingScheduler implements MonitorNotificationScheduler {
	readonly inner = new FakeScheduler();
	armed = 0;
	now(): number {
		return this.inner.now();
	}
	setTimeout(callback: () => void, delayMs: number): unknown {
		this.armed += 1;
		return this.inner.setTimeout(callback, delayMs);
	}
	clearTimeout(timer: unknown): void {
		this.inner.clearTimeout(timer as Parameters<FakeScheduler["clearTimeout"]>[0]);
	}
}

function notifier(options: {
	paced?: Record<string, number>;
	wakeBudget?: number;
	spill?: (id: string, lines: readonly string[]) => MonitorSpillResult | undefined;
}) {
	const scheduler = new CountingScheduler();
	const sent: string[] = [];
	const paused: string[] = [];
	const instance = new MonitorNotifier({
		sendMessage: (message) => sent.push(message.content),
		getContext: () => ({ mode: "tui", model: { id: "mock", api: "openai-completions" } }) as never,
		getMode: () => "wake",
		getSettings: () => ({
			coalesceWindowMs: 2000,
			rateLimitMs: 5000,
			maxLinesPerInjection: 50,
			maxCharsPerInjection: MAX_CHARS,
			wakeBudget: options.wakeBudget ?? 5,
			wakesPerHour: 12,
		}),
		pauseMonitors: (ids) => {
			paused.push(...ids);
			return ids;
		},
		wakesPerHour: (id) => options.paced?.[id],
		...(options.spill === undefined ? {} : { spillOverflow: options.spill }),
		scheduler,
	});
	return { instance, scheduler, sent, paused };
}

/** A line of about 70 characters that is still unique and easy to find in a wake. */
function wide(tag: string, index: number): string {
	return `${tag}-${index}-${"x".repeat(60)}`;
}

function delivered(sent: readonly string[], tag: string): string[] {
	return sent.flatMap((content) => [...content.matchAll(new RegExp(`\\b${tag}-\\d+\\b`, "g"))].map((m) => m[0]));
}

describe("one wake never exceeds its size and never clips a line", () => {
	it("delivers or explicitly counts every line of two unpaced monitors that share a wake, within the size cap", () => {
		const { instance, scheduler, sent } = notifier({});
		for (let index = 0; index < 40; index += 1) {
			instance.notifyEvent(line("bash_a", "alpha", wide("a", index)));
			instance.notifyEvent(line("bash_b", "beta", wide("b", index)));
		}
		scheduler.inner.advanceBy(60_000);

		for (const content of sent) {
			expect(content.length).toBeLessThanOrEqual(MAX_CHARS);
			expect(content).not.toMatch(/\.\.\.<\/system-reminder>$/);
		}
		const omitted = (description: string) =>
			sent
				.filter((content) => content.includes(`Monitor event(${description})`))
				.reduce(
					(total, content) => total + Number(/\[(\d+) additional event lines omitted/.exec(content)?.[1] ?? 0),
					0,
				);
		for (const [tag, description] of [
			["a", "alpha"],
			["b", "beta"],
		] as const) {
			const got = delivered(sent, tag);
			expect(got).toEqual(Array.from({ length: got.length }, (_, index) => `${tag}-${index}`));
			expect(got.length + omitted(description)).toBe(40);
		}
	});
});

describe("a session wake-budget pause keeps other monitors' held lines", () => {
	it("still delivers a paced monitor's queued and overflow lines after another monitor trips the budget", () => {
		const spilled: string[] = [];
		const { instance, scheduler, sent, paused } = notifier({
			paced: { bash_slow: 1 },
			wakeBudget: 5,
			spill: (_id, lines) => {
				spilled.push(...lines);
				return { path: "/state/overflow/mon_slow.log", rotated: false };
			},
		});
		// Spend the paced monitor's only token, then queue 80 lines behind it.
		instance.notifyEvent(line("bash_slow", "slow", "s-first"));
		scheduler.inner.advanceBy(2_000);
		for (let index = 0; index < 80; index += 1) instance.notifyEvent(line("bash_slow", "slow", `s-${index}`));
		// An unpaced monitor wakes until the session-global budget pauses it.
		for (let wake = 0; wake < 6; wake += 1) {
			instance.notifyEvent(line("bash_fast", "fast", `f-${wake}`));
			scheduler.inner.advanceBy(5_000);
		}
		expect(paused).toContain("bash_fast");
		expect(paused).not.toContain("bash_slow");

		scheduler.inner.advanceBy(60 * 60 * 1000);
		const slow = [...delivered(sent, "s"), ...spilled.filter((value) => /^s-\d+$/.test(value))];
		expect(slow.filter((value) => value !== "s-first").sort()).toEqual(
			Array.from({ length: 80 }, (_, index) => `s-${index}`).sort(),
		);
	});
});

describe("a paced monitor waiting for its next token does not spin", () => {
	it("arms a handful of timers, not one per coalesce window, while lines keep arriving", () => {
		const { instance, scheduler, sent } = notifier({ paced: { bash_paced: 1 } });
		instance.notifyEvent(line("bash_paced", "paced", "p-first"));
		scheduler.inner.advanceBy(2_000);
		expect(sent).toHaveLength(1);
		const before = scheduler.armed;
		// One line a second for ten minutes while the next token is about an hour away.
		for (let second = 0; second < 600; second += 1) {
			instance.notifyEvent(line("bash_paced", "paced", `p-${second}`));
			scheduler.inner.advanceBy(1_000);
		}
		expect(sent).toHaveLength(1);
		expect(scheduler.armed - before).toBeLessThan(10);
	});
});

describe("an overflow file that rotated during a burst is named with its rotated copy", () => {
	it("points at both files when the spill rotated", () => {
		const { instance, scheduler, sent } = notifier({
			spill: () => ({ path: "/state/overflow/mon_x.log", rotated: true }),
		});
		for (let index = 0; index < 400; index += 1) instance.notifyEvent(line("bash_x", "x", `x-${index}`));
		scheduler.inner.advanceBy(10_000);
		expect(sent[0]).toContain("/state/overflow/mon_x.log.1");
	});
});
