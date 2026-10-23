import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

const WARNING = "queued_input_outlived_run";

function sessionLogLines(harness: Harness): Array<Record<string, unknown>> {
	let raw: string;
	try {
		raw = readFileSync(join(harness.tempDir, "agent", "logs", "session.log"), "utf-8").trim();
	} catch {
		return [];
	}
	return raw === "" ? [] : raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function outlivedWarnings(harness: Harness): Array<Record<string, unknown>> {
	return sessionLogLines(harness).filter((line) => line.event === WARNING);
}

async function runOrdinaryTurn(harness: Harness, text: string): Promise<void> {
	await harness.session.prompt(text);
	await harness.session.waitForIdle();
	await harness.session.waitForSettledSessionWork();
}

describe("#4036 a queued input that outlives a completed run is reported", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("#given a steer queued while idle #when the next run delivers it #then nothing is reported", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled"), fauxAssistantMessage("handled again")]);
		await harness.session.steer("steer queued while idle");

		// when
		await runOrdinaryTurn(harness, "an ordinary turn");
		await runOrdinaryTurn(harness, "another ordinary turn");

		// then
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(outlivedWarnings(harness)).toEqual([]);
	});

	it("#given a steer whose delivery was lost #when a whole run starts and settles without it #then a warning carries its age, mode and source, once", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled"), fauxAssistantMessage("handled again")]);
		await harness.session.steer("steer the agent never receives");
		harness.session.agent.clearAllQueues();

		// when
		await runOrdinaryTurn(harness, "an ordinary turn");
		await runOrdinaryTurn(harness, "another ordinary turn");

		// then
		expect(harness.session.getSteeringMessages()).toEqual(["steer the agent never receives"]);
		const warnings = outlivedWarnings(harness);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ level: "warn", mode: "steer", source: "interactive" });
		expect(warnings[0]?.queuedId).toEqual(expect.any(String));
		expect(warnings[0]?.ageMs).toEqual(expect.any(Number));
	});
});
