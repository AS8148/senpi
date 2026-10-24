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
		const consecutive = detectIdenticalRun(records);
		expect(consecutive?.kind).toBe("identical");
		if (consecutive?.kind !== "identical") return;
		expect(consecutive.windowed).toBe(false);
	});

	it("counts occurrences across a period-5 non-mutating interleave the cycle detector cannot see", () => {
		const fillerNames = ["read", "todo_view", "webfetch", "glob", "grep"];
		const records = interleaved(WINDOWED_REPEAT_THRESHOLD, (i) => [
			fillerNames[i % fillerNames.length] ?? "read",
			{ n: i },
		]);
		expect(detectWindowedRepeat(records)?.count).toBe(WINDOWED_REPEAT_THRESHOLD);
	});

	it("todo interleave keeps counting (todo is not state-changing)", () => {
		const records = interleaved(WINDOWED_REPEAT_THRESHOLD, (i) => ["todo", { view: i }]);
		expect(detectWindowedRepeat(records)?.count).toBe(WINDOWED_REPEAT_THRESHOLD);
	});

	it("stops counting repeats that a state-changing call separates", () => {
		const records = interleaved(WINDOWED_REPEAT_THRESHOLD, (i) => ["edit", { path: `src/a-${i}.ts` }]);
		expect(detectWindowedRepeat(records)).toBeUndefined();
	});
});

describe("detectLoop with windowed repeats", () => {
	it("notices at the threshold and the doubled count when driven on every record, as production does", () => {
		const gate = new NoticeGate();
		const stream: ToolCallRecord[] = [];
		const admitted: number[] = [];
		for (let round = 0; round < 20; round++) {
			stream.push(rec("todo_view", { step: round }));
			const fillerDetection = detectLoop(stream, gate);
			if (fillerDetection !== undefined) throw new Error(`notice on filler record: ${fillerDetection.count}`);
			stream.push(rec("eval", { code: "analyze(x)" }));
			const detection = detectLoop(stream, gate);
			if (detection?.kind === "identical" && detection.windowed) admitted.push(detection.count);
		}
		expect(admitted).toEqual([WINDOWED_REPEAT_THRESHOLD, WINDOWED_REPEAT_THRESHOLD * 2]);
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

describe("consecutive ladder pin (main timing)", () => {
	it("burst, edit, new consecutive run still notices at the consecutive threshold", () => {
		const gate = new NoticeGate();
		const readA = () => rec("read", { path: "a.ts" });
		const edit = (i: number) => rec("edit", { path: "b.ts", n: i });
		const stream: ToolCallRecord[] = [];
		const admitted: number[] = [];
		const drive = (record: ToolCallRecord): void => {
			stream.push(record);
			const detection = detectLoop(stream, gate);
			if (detection?.kind === "identical" && !detection.windowed) admitted.push(detection.count);
		};
		// first burst: notify at run 3
		for (let i = 0; i < 3; i++) drive(readA());
		expect(admitted.length).toBe(1);
		expect(admitted[0]).toBe(3);
		// state-changing separator
		drive(edit(1));
		// new consecutive run of the same call: must notify at 3 again (base behavior)
		for (let i = 0; i < 3; i++) drive(readA());
		expect(admitted.length).toBe(2);
		expect(admitted[1]).toBe(3);
	});
});
