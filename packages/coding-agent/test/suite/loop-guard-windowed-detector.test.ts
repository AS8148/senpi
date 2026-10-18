import { describe, expect, it } from "vitest";
import {
	detectIdenticalRun,
	detectLoop,
	detectWindowedRepeat,
	NoticeGate,
} from "../../src/core/extensions/builtin/loop-guard/detectors.ts";
import { buildLoopGuardReminder } from "../../src/core/extensions/builtin/loop-guard/notice.ts";
import { WINDOWED_REPEAT_THRESHOLD } from "../../src/core/extensions/builtin/loop-guard/policy.ts";
import type { ToolCallRecord } from "../../src/core/extensions/builtin/loop-guard/tracker.ts";
import { canonicalizeArgs } from "../../src/core/extensions/builtin/loop-guard/tracker.ts";

function rec(toolName: string, args: unknown): ToolCallRecord {
	const argsJson = canonicalizeArgs(args);
	return { toolName, argsJson, signature: `${toolName}\u0000${argsJson}` };
}

function interleaved(evalCount: number, filler: (index: number) => [string, unknown]): ToolCallRecord[] {
	const records: ToolCallRecord[] = [];
	for (let i = 0; i < evalCount; i++) {
		const [name, args] = filler(i);
		records.push(rec(name, args));
		records.push(rec("eval", { code: "analyze(x)" }));
	}
	return records;
}

describe("detectWindowedRepeat", () => {
	it("stays silent below the windowed threshold", () => {
		const records = interleaved(WINDOWED_REPEAT_THRESHOLD - 1, (i) => ["todo_view", { step: i }]);
		expect(detectWindowedRepeat(records)).toBeUndefined();
	});

	it("fires on non-consecutive identical repeats at the threshold", () => {
		const records = interleaved(WINDOWED_REPEAT_THRESHOLD, (i) => ["todo_view", { step: i }]);
		const detection = detectWindowedRepeat(records);
		expect(detection?.kind).toBe("identical");
		if (detection?.kind !== "identical") return;
		expect(detection.windowed).toBe(true);
		expect(detection.toolName).toBe("eval");
		expect(detection.count).toBe(WINDOWED_REPEAT_THRESHOLD);
	});

	it("stays silent while the trailing run is long enough to report itself", () => {
		const records = [
			...interleaved(WINDOWED_REPEAT_THRESHOLD - 3, (i) => ["todo_view", { step: i }]),
			rec("eval", { code: "analyze(x)" }),
			rec("eval", { code: "analyze(x)" }),
			rec("eval", { code: "analyze(x)" }),
		];
		expect(detectWindowedRepeat(records)).toBeUndefined();
		expect(detectIdenticalRun(records)?.windowed).toBe(false);
	});

	it("counts occurrences across a period-7 interleave the cycle detector cannot see", () => {
		const fillerNames = ["read", "edit", "bash", "todo_view", "webfetch", "glob", "grep"];
		const records = interleaved(WINDOWED_REPEAT_THRESHOLD, (i) => [
			fillerNames[i % fillerNames.length] ?? "read",
			{ n: i },
		]);
		expect(detectWindowedRepeat(records)?.count).toBe(WINDOWED_REPEAT_THRESHOLD);
	});
});

describe("detectLoop with windowed repeats", () => {
	it("admits the first windowed detection and re-fires at the doubled count", () => {
		const gate = new NoticeGate();
		const records = interleaved(WINDOWED_REPEAT_THRESHOLD, (i) => ["todo_view", { step: i }]);
		const first = detectLoop(records, gate);
		expect(first?.kind).toBe("identical");
		if (first?.kind !== "identical") return;
		expect(first.windowed).toBe(true);
		expect(first.count).toBe(WINDOWED_REPEAT_THRESHOLD);

		const grow = (evalCount: number): ToolCallRecord[] =>
			[
				...records,
				...interleaved(evalCount - WINDOWED_REPEAT_THRESHOLD, (i) => ["todo_view", { step: 100 + i }]),
			].slice(-64);
		expect(detectLoop(grow(12), gate)).toBeUndefined();
		expect(detectLoop(grow(16), gate)?.count).toBe(16);
	});
});

describe("buildLoopGuardReminder windowed identical", () => {
	it("uses the windowed headline and count, not the consecutive phrasing", () => {
		const reminder = buildLoopGuardReminder({
			kind: "identical",
			windowed: true,
			toolName: "eval",
			count: WINDOWED_REPEAT_THRESHOLD,
			fingerprint: "fp",
		});
		expect(reminder).toContain("REPEATED IDENTICAL TOOL CALLS");
		expect(reminder).toContain("`eval` 8 times");
		expect(reminder).not.toContain("in a row");
	});
});
