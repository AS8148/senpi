import { OBSERVING_TOOL_NAMES, TRACK_WINDOW } from "./policy.ts";

export interface ToolCallRecord {
	readonly toolName: string;
	readonly argsJson: string;
	readonly signature: string;
}

export function canonicalizeArgs(args: unknown): string {
	return stableStringify(args ?? {});
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	const parts: string[] = [];
	for (const key of keys) {
		const entry = record[key];
		if (entry === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${stableStringify(entry)}`);
	}
	return `{${parts.join(",")}}`;
}

export class ToolCallTracker {
	private calls: ToolCallRecord[] = [];
	/**
	 * Cumulative windowed occurrences per signature: incremented on the signature's own
	 * calls, cleared for every signature when a call that is not known-observing runs.
	 * Deliberately NOT capped by TRACK_WINDOW — a cap made the count stall near the
	 * threshold at wider repeat spacing (senpi#3641 review round 7), which both flooded
	 * notices at the window edge and made the doubling threshold unreachable.
	 */
	private readonly windowedCounts = new Map<string, number>();

	record(toolName: string, args: unknown): ToolCallRecord {
		const argsJson = canonicalizeArgs(args);
		const record = { toolName, argsJson, signature: `${toolName}\u0000${argsJson}` };
		this.calls.push(record);
		if (this.calls.length > TRACK_WINDOW) {
			this.calls = this.calls.slice(-TRACK_WINDOW);
		}
		if (OBSERVING_TOOL_NAMES.has(toolName)) {
			this.windowedCounts.set(record.signature, (this.windowedCounts.get(record.signature) ?? 0) + 1);
		} else {
			// A call outside the observing allowlist can change state, so earlier repeats
			// are stale observations — but this call's own streak continues (round 4 rule).
			const own = this.windowedCounts.get(record.signature) ?? 0;
			this.windowedCounts.clear();
			this.windowedCounts.set(record.signature, own + 1);
		}
		return record;
	}

	/** Cumulative windowed occurrences of one signature since the last non-observing call. */
	windowedCount(signature: string): number {
		return this.windowedCounts.get(signature) ?? 0;
	}

	/** True while the signature appears anywhere in the recent-call window (the loop is still live). */
	seenInWindow(signature: string): boolean {
		for (const call of this.calls) {
			if (call.signature === signature) return true;
		}
		return false;
	}

	get records(): readonly ToolCallRecord[] {
		return this.calls;
	}

	reset(): void {
		this.calls = [];
		this.windowedCounts.clear();
	}
}
