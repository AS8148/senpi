import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { registerFallbackModels } from "./fallback-provider-fixture.ts";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "other-faux/faux-2";

const networkReset = () =>
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "TypeError: fetch failed (ECONNRESET): connection reset by peer",
	});

describe("pure network-transient failures never open the fallback circuit", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("#given consecutive network resets past the same-model budget #when the model would recover #then the session never switches models and the circuit stays closed", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			fallbackNow: () => 0,
			settings: {
				retry: { enabled: true, baseDelayMs: 1, maxRetries: 1, fallbackChains: { [primary]: [fallback] } },
			},
		});
		harnesses.push(harness);
		registerFallbackModels(harness, "other-faux", ["faux-2"]);
		harness.setResponses([networkReset(), networkReset(), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("flaky network");

		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["faux-1", "faux-1"]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
	});
});
