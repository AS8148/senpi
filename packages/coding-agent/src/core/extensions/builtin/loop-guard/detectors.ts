import {
	CYCLE_MAX_PERIOD,
	CYCLE_MIN_PERIOD,
	CYCLE_REPETITION_THRESHOLD,
	ESCALATION_FACTOR,
	IDENTICAL_RUN_THRESHOLD,
	MUTATING_TOOL_NAMES,
	SIMILAR_RUN_THRESHOLD,
	SIMILARITY_THRESHOLD,
	TRACK_WINDOW,
	WINDOWED_REPEAT_THRESHOLD,
} from "./policy.ts";
import { meanAdjacentSimilarity } from "./similarity.ts";
import type { ToolCallRecord } from "./tracker.ts";

const TARGET_FIELDS = new Map<string, readonly string[]>([
	["read", ["path"]],
	["bash_output", ["bash_id"]],
	["task_output", ["task_id", "name"]],
	["task_update", ["task_id"]],
	["task_send", ["to"]],
	["lsp_diagnostics", ["filePath"]],
]);

export type LoopGuardDetection =
	| {
			readonly kind: "identical";
			readonly windowed: boolean;
			readonly toolName: string;
			readonly count: number;
			readonly fingerprint: string;
	  }
	| {
			readonly kind: "similar";
			readonly toolName: string;
			readonly count: number;
			readonly similarity: number;
			readonly fingerprint: string;
	  }
	| {
			readonly kind: "cycle";
			readonly period: number;
			readonly count: number;
			readonly cycleTools: readonly string[];
			readonly fingerprint: string;
	  };

export type LoopGuardKind = LoopGuardDetection["kind"];

function targetIdentity(record: ToolCallRecord): string | undefined {
	const fields = TARGET_FIELDS.get(record.toolName);
	if (fields === undefined) return undefined;
	let args: unknown;
	try {
		args = JSON.parse(record.argsJson);
	} catch {
		return undefined;
	}
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	for (const field of fields) {
		const value: unknown = Reflect.get(args, field);
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function hasAllDistinctTargets(records: readonly ToolCallRecord[]): boolean {
	const identities: string[] = [];
	for (const record of records) {
		const identity = targetIdentity(record);
		if (identity === undefined) return false;
		identities.push(identity);
	}
	return new Set(identities).size === identities.length;
}

export function detectIdenticalRun(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
	const last = records[records.length - 1];
	if (last === undefined) return undefined;
	let run = 1;
	for (let i = records.length - 2; i >= 0; i--) {
		if (records[i]?.signature !== last.signature) break;
		run++;
	}
	if (run < IDENTICAL_RUN_THRESHOLD) return undefined;
	return { kind: "identical", windowed: false, toolName: last.toolName, count: run, fingerprint: last.signature };
}

export function detectWindowedRepeat(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
	if (detectIdenticalRun(records) !== undefined) return undefined;
	const last = records[records.length - 1];
	if (last === undefined) return undefined;
	const occurrences = windowedRepeatCount(records, last.signature);
	if (occurrences < WINDOWED_REPEAT_THRESHOLD) return undefined;
	return {
		kind: "identical",
		windowed: true,
		toolName: last.toolName,
		count: occurrences,
		fingerprint: last.signature,
	};
}

/**
 * Occurrences of `signature` since the most recent state-changing call of a DIFFERENT
 * signature (whole window when none ran). The signature's own occurrences always count —
 * a call repeating identically is itself the pathology — while a different tool changing
 * state between repeats makes those repeats new observations, not a loop.
 */
export function windowedRepeatCount(records: readonly ToolCallRecord[], signature: string): number {
	let occurrences = 0;
	for (const record of records) {
		if (record.signature === signature) {
			occurrences++;
		} else if (MUTATING_TOOL_NAMES.has(record.toolName)) {
			occurrences = 0;
		}
	}
	return occurrences;
}

/** Fingerprints whose windowed repeat count still meets the threshold, whether or not the last call is one of them. */
export function windowedOverThreshold(records: readonly ToolCallRecord[]): ReadonlySet<string> {
	const over = new Set<string>();
	for (const record of records) {
		if (!over.has(record.signature) && windowedRepeatCount(records, record.signature) >= WINDOWED_REPEAT_THRESHOLD) {
			over.add(record.signature);
		}
	}
	return over;
}

export function detectSimilarRun(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
	const last = records[records.length - 1];
	if (last === undefined) return undefined;
	let run = 1;
	for (let i = records.length - 2; i >= 0; i--) {
		if (records[i]?.toolName !== last.toolName) break;
		run++;
	}
	if (run < SIMILAR_RUN_THRESHOLD) return undefined;
	const runRecords = records.slice(records.length - run);
	const argStrings = runRecords.map((record) => record.argsJson);
	if (new Set(argStrings).size === 1) return undefined;
	if (hasAllDistinctTargets(runRecords)) return undefined;
	const similarity = meanAdjacentSimilarity(argStrings);
	if (similarity < SIMILARITY_THRESHOLD) return undefined;
	return { kind: "similar", toolName: last.toolName, count: run, similarity, fingerprint: last.toolName };
}

export function detectCycle(records: readonly ToolCallRecord[]): LoopGuardDetection | undefined {
	const total = records.length;
	for (let period = CYCLE_MIN_PERIOD; period <= CYCLE_MAX_PERIOD; period++) {
		if (total < period * CYCLE_REPETITION_THRESHOLD) continue;
		const cycle = records.slice(total - period);
		if (new Set(cycle.map((record) => record.signature)).size < 2) continue;
		let repetitions = 1;
		while (repetitions * period + period <= total) {
			const blockStart = total - (repetitions + 1) * period;
			let matches = true;
			for (let offset = 0; offset < period; offset++) {
				if (records[blockStart + offset]?.signature !== cycle[offset]?.signature) {
					matches = false;
					break;
				}
			}
			if (!matches) break;
			repetitions++;
		}
		if (repetitions < CYCLE_REPETITION_THRESHOLD) continue;
		return {
			kind: "cycle",
			period,
			count: repetitions,
			cycleTools: cycle.map((record) => record.toolName),
			// Rotation-invariant: a cycle and its rotation are one loop, so the gate entry
			// (and its notice throttle) must not alternate between two keys per record.
			fingerprint: [...cycle.map((record) => record.signature)].sort().join("\u0001"),
		};
	}
	return undefined;
}

interface GateEntry {
	fingerprint: string;
	lastNotifiedCount: number;
	saturationNotified: boolean;
}

function maximumObservableCount(detection: LoopGuardDetection): number {
	switch (detection.kind) {
		case "identical":
		case "similar":
			return TRACK_WINDOW;
		case "cycle":
			return Math.floor(TRACK_WINDOW / detection.period);
	}
}

export class NoticeGate {
	private entries = new Map<string, GateEntry>();

	private static key(detection: LoopGuardDetection): string {
		return `${detection.kind}\u0000${detection.fingerprint}`;
	}

	admit(detection: LoopGuardDetection): boolean {
		const maximumCount = maximumObservableCount(detection);
		const existing = this.entries.get(NoticeGate.key(detection));
		if (existing === undefined || existing.fingerprint !== detection.fingerprint) {
			this.entries.set(NoticeGate.key(detection), {
				fingerprint: detection.fingerprint,
				lastNotifiedCount: detection.count,
				saturationNotified: detection.count >= maximumCount,
			});
			return true;
		}
		const reachedDoubledCount = detection.count >= existing.lastNotifiedCount * ESCALATION_FACTOR;
		const reachedSaturation = !existing.saturationNotified && detection.count >= maximumCount;
		if (reachedDoubledCount || reachedSaturation) {
			existing.lastNotifiedCount = detection.count;
			if (reachedSaturation) existing.saturationNotified = true;
			return true;
		}
		return false;
	}

	/** Removes entries whose kind+fingerprint key is no longer active (detected or still over the windowed threshold). */
	prune(active: ReadonlySet<string>): void {
		for (const key of this.entries.keys()) {
			if (!active.has(key)) this.entries.delete(key);
		}
	}

	reset(): void {
		this.entries.clear();
	}
}

export function detectLoop(records: readonly ToolCallRecord[], gate: NoticeGate): LoopGuardDetection | undefined {
	const detections = [
		detectIdenticalRun(records),
		detectWindowedRepeat(records),
		detectCycle(records),
		detectSimilarRun(records),
	];
	const active = new Set<string>();
	for (const detection of detections) {
		if (detection !== undefined) active.add(`${detection.kind}\u0000${detection.fingerprint}`);
	}
	// Gate entries must survive the filler calls between repeats, or a recurring
	// short identical burst re-creates its entry every time and notices on every
	// burst: a windowed entry stays active while its mutation-aware count is over
	// the windowed threshold, and an identical entry while its raw in-window
	// occurrence count is over the consecutive threshold.
	const rawCounts = new Map<string, number>();
	for (const record of records) rawCounts.set(record.signature, (rawCounts.get(record.signature) ?? 0) + 1);
	for (const fingerprint of windowedOverThreshold(records)) {
		active.add(`identical\u0000${fingerprint}`);
	}
	for (const [fingerprint, count] of rawCounts) {
		if (count >= IDENTICAL_RUN_THRESHOLD) active.add(`identical\u0000${fingerprint}`);
	}
	gate.prune(active);
	for (const detection of detections) {
		if (detection !== undefined && gate.admit(detection)) return detection;
	}
	return undefined;
}
