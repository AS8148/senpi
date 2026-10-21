import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { assertAgentDirAllowedInTests, getAgentDir, RealAgentDirInTestError } from "../src/config.ts";

// #3867: a run without the quarantine setup resolved the real agent dir and left faux pool state there.
// Every case below only resolves a path; nothing is written.

const realHome = userInfo().homedir;
const underTest = { VITEST: "true" };

describe("assertAgentDirAllowedInTests", () => {
	test.each([".senpi", ".omo", ".pi"])("throws for the real home's %s agent dir under a test runner", (brandDir) => {
		expect(() => assertAgentDirAllowedInTests(join(realHome, brandDir, "agent"), ".senpi", underTest)).toThrow(
			RealAgentDirInTestError,
		);
	});

	test("throws for the active brand's flat config dir and anything below it", () => {
		expect(() => assertAgentDirAllowedInTests(join(realHome, ".acme"), ".acme", underTest)).toThrow(
			RealAgentDirInTestError,
		);
		expect(() => assertAgentDirAllowedInTests(join(realHome, ".acme", "nested"), ".acme", underTest)).toThrow(
			RealAgentDirInTestError,
		);
	});

	test("treats bun test (NODE_ENV=test) as a test runner", () => {
		expect(() =>
			assertAgentDirAllowedInTests(join(realHome, ".omo", "agent"), ".senpi", { NODE_ENV: "test" }),
		).toThrow(RealAgentDirInTestError);
	});

	test("allows temp dirs, look-alike siblings, the explicit opt-in, and non-test processes", () => {
		const real = join(realHome, ".omo", "agent");
		expect(() => assertAgentDirAllowedInTests(join(tmpdir(), "agent"), ".senpi", underTest)).not.toThrow();
		expect(() => assertAgentDirAllowedInTests(join(realHome, ".omo-backup"), ".senpi", underTest)).not.toThrow();
		expect(() =>
			assertAgentDirAllowedInTests(real, ".senpi", { ...underTest, SENPI_TEST_USE_REAL_AGENT_DIR: "1" }),
		).not.toThrow();
		expect(() => assertAgentDirAllowedInTests(real, ".senpi", {})).not.toThrow();
	});
});

describe("getAgentDir under a test runner", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("throws instead of returning the real agent dir an inherited env points at", () => {
		vi.stubEnv("SENPI_CODING_AGENT_DIR", join(realHome, ".omo", "agent"));

		expect(() => getAgentDir()).toThrow(RealAgentDirInTestError);
	});

	test("still returns a quarantined dir", () => {
		const quarantined = join(tmpdir(), "senpi-guard-quarantine", "agent");
		vi.stubEnv("SENPI_CODING_AGENT_DIR", quarantined);

		expect(getAgentDir()).toBe(quarantined);
	});
});
