import { describe, expect, it } from "vitest";
import { attempt, createLoopGuardHarness, type LoopGuardHarness } from "../loop-guard-test-harness.ts";

/** Documented detection count from loop-guard policy: the 8th identical call in the window warns. */
const DOCUMENTED_WINDOWED_THRESHOLD = 8;

interface BlockResult {
	block: boolean;
	reason: string;
	terminate: boolean;
}

const EVAL_ARGS = { code: "reverseEngineer(input)" } as const;
const TODO_ARGS = { view: "list" } as const;

function isBlockResult(value: unknown): value is BlockResult {
	return typeof value === "object" && value !== null && "block" in value && (value as { block: unknown }).block === true;
}

async function runInterleavedRound(harness: LoopGuardHarness, round: number): Promise<unknown> {
	await attempt(harness, `todo-${round}`, "todo_view", { ...TODO_ARGS, round });
	return attempt(harness, `eval-${round}`, "eval", { ...EVAL_ARGS });
}

describe("issue 3629: interleaved identical repeats escalate to a hard stop", () => {
	it("notifies, blocks, and hard-stops an eval loop interleaved with todo calls", async () => {
		const harness = createLoopGuardHarness();
		let firstBlockedRound = 0;
		let blockedCount = 0;
		let hardStopRound = 0;
		for (let round = 1; round <= 40; round++) {
			const result = await runInterleavedRound(harness, round);
			if (isBlockResult(result)) {
				blockedCount++;
				if (firstBlockedRound === 0) firstBlockedRound = round;
				if (hardStopRound === 0 && harness.actions.includes("abort:system")) hardStopRound = round;
			}
		}
		const notices = harness.customMessages.filter((message) => message.customType === "loop-guard:notice");
		const escalations = harness.customMessages.filter((message) => message.customType === "loop-guard:escalation");
		await harness.fire("agent_settled", { type: "agent_settled" });

		expect(notices.length).toBeGreaterThanOrEqual(2);
		expect(firstBlockedRound).toBeLessThanOrEqual(2 * DOCUMENTED_WINDOWED_THRESHOLD + 4);
		expect(blockedCount).toBeGreaterThanOrEqual(3);
		expect(hardStopRound).toBeGreaterThan(0);
		expect(harness.actions).toContain("abort:system");
		expect(escalations.length).toBe(1);
		expect(harness.actions).toContain("recovery-turn");
	});

	it("does not disarm when many other-signature calls arrive between repeats", async () => {
		const harness = createLoopGuardHarness();
		for (let round = 1; round <= DOCUMENTED_WINDOWED_THRESHOLD; round++) {
			await runInterleavedRound(harness, round);
		}
		for (let filler = 0; filler < 5; filler++) {
			await attempt(harness, `read-${filler}`, "read", { path: `src/file-${filler}.ts` });
		}
		const result = await attempt(harness, "eval-after-filler", "eval", { ...EVAL_ARGS });
		const notices = harness.customMessages.filter((message) => message.customType === "loop-guard:notice");
		expect(notices.length).toBeGreaterThanOrEqual(1);
		expect(result).toBeUndefined();
	});

	it("forgives the loop once the signature ages out of the window", async () => {
		const harness = createLoopGuardHarness();
		for (let round = 1; round <= 20; round++) {
			await runInterleavedRound(harness, round);
		}
		expect(harness.actions).toContain("abort:system");
		for (let filler = 0; filler < 64; filler++) {
			await attempt(harness, `varied-${filler}`, "read", { path: `src/other-${filler}.ts` });
		}
		const result = await attempt(harness, "eval-aged-out", "eval", { ...EVAL_ARGS });
		expect(result).toBeUndefined();
	});
});
