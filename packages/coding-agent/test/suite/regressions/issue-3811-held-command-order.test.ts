import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type ResumeFixture, resumeFixture, runRef, settle } from "./issue-3811-resume-support.ts";

async function textFixture(): Promise<ResumeFixture> {
	const fixture = await resumeFixture();
	fixture.h.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	return fixture;
}

describe("senpi#3811 held extension commands run in order before the releasing turn", () => {
	const fixtures: ResumeFixture[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) {
			await fixture.h.session.abort();
			fixture.h.cleanup();
		}
	});

	it("finishes a held command before the person's releasing turn starts", async () => {
		// Given a child paused for its parent's run with a command held, and its own newer Stop
		const fixture = await textFixture();
		fixtures.push(fixture);
		const order: string[] = [];
		fixture.api().registerCommand("note", {
			description: "Record a note",
			handler: async (args) => {
				order.push(`command:start ${args}`);
				// One macrotask: every microtask step of a turn admitted alongside this command runs before it ends.
				await new Promise<void>((resolve) => setImmediate(resolve));
				order.push("command:end");
			},
		});
		const paused = await fixture.h.session.pauseForRun({ parentSessionId: "p", parentPauseSeq: 1, runRef });
		if (!("childSeq" in paused)) throw new Error("pause_for_run was refused");
		await fixture.h.session.prompt("/note remember staging");
		await fixture.h.session.stop();

		// When the parent resumes the run, which leaves the child's own Stop in place
		const resumed = await fixture.h.session.resumeForRun({
			parentSessionId: "p",
			parentPauseSeq: 1,
			childSeqCutoff: paused.childSeq,
		});
		expect(resumed).toMatchObject({ released: true, otherHoldLive: true });
		expect(fixture.h.session.pausedHeldInputCount).toBe(1);

		// And the person's next message releases that Stop
		fixture.h.session.subscribe((event) => {
			if (event.type === "agent_start") order.push("turn:start");
		});
		await fixture.h.session.prompt("Carry on");
		await settle(fixture);

		// Then the held command ran to completion before the person's turn started
		expect(order).toEqual(["command:start remember staging", "command:end", "turn:start"]);
		expect(fixture.h.faux.state.callCount).toBe(1);
		expect(fixture.h.session.pausedHeldInputCount).toBe(0);
	});
});
