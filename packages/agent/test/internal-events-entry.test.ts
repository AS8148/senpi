import { describe, expect, it } from "vitest";
import * as publicEntry from "../src/index.ts";

// senpi#4272 (RULING-05 D4, #4349 review LOW-3): the internal agent channel is reachable only through the
// internal-events subpath; the main entry must not export it, so extensions holding an Agent cannot subscribe
// to structured controls.
describe("internal agent channel stays off the public entry", () => {
	it("D4 the main entry does not export subscribeInternalAgent", () => {
		expect(Object.keys(publicEntry)).not.toContain("subscribeInternalAgent");
		expect(Object.keys(publicEntry)).not.toContain("dispatchInternalAgent");
	});
});
