import { describe, expect, it } from "vitest";
import { QueuedInputAges } from "../src/core/queued-input-age.ts";

describe("QueuedInputAges", () => {
	it("#given input queued before a run #when that run settles with it still queued #then it is reported once with its age", () => {
		// given
		const ages = new QueuedInputAges();
		ages.noteQueued("q_1", 1_000);

		// when
		ages.noteRunStarted();
		const first = ages.takeOutlived(["q_1"], 4_500);
		ages.noteRunStarted();
		const second = ages.takeOutlived(["q_1"], 9_000);

		// then
		expect(first).toEqual([{ queuedId: "q_1", ageMs: 3_500 }]);
		expect(second).toEqual([]);
	});

	it("#given input queued during a run #when that same run settles #then it is not reported until a later run also settles", () => {
		// given
		const ages = new QueuedInputAges();
		ages.noteRunStarted();
		ages.noteQueued("q_1", 2_000);

		// when
		const sameRun = ages.takeOutlived(["q_1"], 2_500);
		ages.noteRunStarted();
		const laterRun = ages.takeOutlived(["q_1"], 6_000);

		// then
		expect(sameRun).toEqual([]);
		expect(laterRun).toEqual([{ queuedId: "q_1", ageMs: 4_000 }]);
	});

	it("#given input that was delivered #when later runs settle #then it is never reported", () => {
		// given
		const ages = new QueuedInputAges();
		ages.noteQueued("q_1", 0);
		ages.noteQueued("q_2", 0);

		// when
		ages.noteRunStarted();
		const outlived = ages.takeOutlived(["q_2"], 10);
		ages.noteRunStarted();
		const afterDelivery = ages.takeOutlived([], 20);

		// then
		expect(outlived).toEqual([{ queuedId: "q_2", ageMs: 10 }]);
		expect(afterDelivery).toEqual([]);
	});
});
