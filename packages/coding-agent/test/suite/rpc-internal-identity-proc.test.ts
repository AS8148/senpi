import { describe, expect, it } from "vitest";
import {
	observeProcessStartMs,
	processStartTimeMs,
	readProcessStartTime,
	sameProcessStartMs,
} from "../../src/utils/process-identity.ts";

// senpi#3816 review: Linux reads the supervisor's start time from /proc, so the poll spawns nothing.
describe.skipIf(process.platform !== "linux")("spawn-free process start time", () => {
	it("matches the ps start time of a live process", async () => {
		const lstart = await readProcessStartTime(process.pid);
		expect(lstart).toBeDefined();
		const observed = await observeProcessStartMs(process.pid, "linux");
		expect(observed).toBeDefined();
		expect(sameProcessStartMs(processStartTimeMs(lstart ?? ""), observed)).toBe(true);
	});

	it("reports an unreadable /proc entry as unknown, never as a time", async () => {
		expect(await observeProcessStartMs(2 ** 30, "linux")).toBeUndefined();
	});
});
