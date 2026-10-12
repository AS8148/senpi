import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { main } from "../../../src/main.ts";

afterEach(() => vi.restoreAllMocks());

// #3167: a removed integration command must never become a model prompt.
describe("retired app-server invocation", () => {
	it.each([
		{ args: ["app-server"] },
		{ args: ["app-server", "--listen", "stdio://"] },
		{ args: ["app-server", "daemon", "start"] },
		{ args: ["app-server", "--help", "-ne"] },
	])("rejects $args without collecting a prompt", ({ args }) => {
		const parsed = parseArgs(args);
		expect(parsed.diagnostics).toEqual([expect.objectContaining({ type: "error" })]);
		expect(parsed.messages).toEqual([]);
	});

	it("exits before initializing a model runtime", async () => {
		const exit = new Error("CLI exited");
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw exit;
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const createRuntime = vi.spyOn(ModelRuntime, "create");

		await expect(main(["app-server", "--help", "-ne"])).rejects.toBe(exit);

		expect(exitSpy).toHaveBeenCalledExactlyOnceWith(1);
		expect(errors).toHaveBeenCalled();
		expect(createRuntime).not.toHaveBeenCalled();
	});

	it("keeps explicit prompt text and Native RPC arguments usable", () => {
		const prompt = parseArgs(["-p", "--", "app-server"]);
		expect(prompt.diagnostics).toEqual([]);
		expect(prompt.messages).toEqual(["app-server"]);

		const rpc = parseArgs(["--mode", "rpc", "--multi-session"]);
		expect(rpc.diagnostics).toEqual([]);
		expect(rpc.mode).toBe("rpc");
		expect(rpc.multiSession).toBe(true);
	});
});
