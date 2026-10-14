import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "./fallback-provider-fixture.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "other-faux/faux-2";

// Kakao report: a model that hits a rate limit and falls back must be retried once the limit's
// own reset window passes, not held for a generic cooldown that doubles on each consecutive
// failure past that window. Two consecutive limit failures (the primary is still limited at the
// first retry) double the circuit cooldown past the reset window; the session must still return
// to the primary at the window (senpi#3300).
const SESSION_LIMIT =
	"Devin stream error resource_exhausted: Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 9 minutes (at 16:56 UTC).";

function errorTurn(errorMessage: string) {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

describe("a rate-limit fallback is retried at its reset window, not held for a doubling cooldown", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("#given two consecutive rate-limit failures on the primary #when the reset window passes #then the session retries the primary", async () => {
		let now = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => now,
			settings: {
				retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		harness.setResponses([
			errorTurn(SESSION_LIMIT),
			fauxAssistantMessage("fallback answer"),
			// The window passes; the primary is healthy again.
			fauxAssistantMessage("primary answer"),
		]);

		await harness.session.prompt("first");
		expect(harness.session.model?.id).toBe("faux-2");

		now += 10 * 60_000; // past the 9-minute reset window
		await harness.session.prompt("second");

		const reverted = harness.eventsOfType("retry_fallback_reverted");
		expect(reverted).toHaveLength(1);
		expect(reverted[0]).toMatchObject({ from: fallback, to: primary });
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.faux.getCallLog()[2]?.modelId).toBe("faux-1");
	});
});
