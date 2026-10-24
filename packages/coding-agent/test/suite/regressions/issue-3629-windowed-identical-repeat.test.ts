import { describe, expect, it } from "vitest";
import { attempt, createLoopGuardHarness } from "../loop-guard-test-harness.ts";

/**
 * Pins for the consecutive-repeat ladder's existing timing, added with senpi#3629:
 * the interleaved (non-consecutive) blind spot is tracked in the follow-up issue;
 * these tests guard that the consecutive stop keeps its exact behavior while the
 * windowed detector is designed there.
 */

const EVAL_ARGS = { code: "reverseEngineer(input)" } as const;

describe("issue 3629: consecutive ladder pins", () => {
	it("blocks and hard-stops a tight identical run", async () => {
		const harness = createLoopGuardHarness();
		for (let round = 1; round <= 30; round++) {
			await attempt(harness, `eval-${round}`, "eval", { ...EVAL_ARGS });
		}
		expect(harness.actions).toContain("abort:system");
	});

	it("notifies at the consecutive threshold and again after a break", async () => {
		const harness = createLoopGuardHarness();
		for (let round = 1; round <= 3; round++) {
			await attempt(harness, `read-${round}`, "read", { path: "a.ts" });
		}
		let notices = harness.customMessages.filter((message) => message.customType === "loop-guard:notice");
		expect(notices.length).toBeGreaterThanOrEqual(1);
		await attempt(harness, "edit-1", "edit", { path: "b.ts", old: "x", new: "y" });
		for (let round = 4; round <= 6; round++) {
			await attempt(harness, `read-${round}`, "read", { path: "a.ts" });
		}
		notices = harness.customMessages.filter((message) => message.customType === "loop-guard:notice");
		expect(notices.length).toBeGreaterThanOrEqual(2);
	});
});
