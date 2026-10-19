// senpi#3566: until the Windows containment lands, `--tool-runtime child` is refused on win32 with a typed reason, from the
// flag, from the env, and from a session built directly - so no half-gated Windows launch path is ever reachable.
import { describe, expect, it } from "vitest";
import {
	resolveToolRuntime,
	TOOL_RUNTIME_UNSUPPORTED_HOST,
	toolRuntimeHostRefusal,
} from "../../src/cli/tool-runtime.ts";
import { createHarness } from "./harness.ts";

describe("tool runtime child on win32", () => {
	it("is refused from the flag and from the env, and allowed elsewhere", () => {
		const fromFlag = resolveToolRuntime({ toolRuntime: "child" }, {}, "win32");
		expect(fromFlag.ok).toBe(false);
		expect(fromFlag.ok ? "" : fromFlag.message).toMatch(new RegExp(`^${TOOL_RUNTIME_UNSUPPORTED_HOST}: `));
		const fromEnv = resolveToolRuntime({}, { SENPI_TOOL_RUNTIME: "child" }, "win32");
		expect(fromEnv.ok ? "" : fromEnv.message).toMatch(new RegExp(`^${TOOL_RUNTIME_UNSUPPORTED_HOST}: `));
		expect(resolveToolRuntime({ toolRuntime: "in-process" }, {}, "win32")).toEqual({ ok: true, value: "in-process" });
		expect(resolveToolRuntime({ toolRuntime: "child" }, {}, "darwin")).toEqual({ ok: true, value: "child" });
		expect(resolveToolRuntime({ toolRuntime: "child" }, {}, "linux")).toEqual({ ok: true, value: "child" });
	});

	it("refuses a session built directly with toolRuntime child", async () => {
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			await expect(createHarness({ toolRuntime: "child" })).rejects.toMatchObject({
				code: TOOL_RUNTIME_UNSUPPORTED_HOST,
			});
		} finally {
			if (original !== undefined) Object.defineProperty(process, "platform", original);
		}
		expect(process.platform).not.toBe("win32");
	});

	it("names the reason and the way out", () => {
		expect(toolRuntimeHostRefusal("child", "win32")).toContain("use in-process");
		expect(toolRuntimeHostRefusal("in-process", "win32")).toBeUndefined();
	});
});
