import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { enableStartupCompileCache } from "../src/compile-cache.ts";

const { enableCompileCache } = vi.hoisted(() => ({
	enableCompileCache: vi.fn(() => ({ directory: "/compile-cache" })),
}));
vi.mock("node:module", () => ({ enableCompileCache }));
const originalArgv = process.argv;

beforeEach(() => {
	vi.stubEnv("NODE_COMPILE_CACHE", undefined);
	enableCompileCache.mockClear();
});

afterEach(() => {
	process.argv = originalArgv;
	vi.unstubAllEnvs();
});

describe("startup compile cache invocation decision", () => {
	test.each(
		[
			["--help"],
			["-h"],
			["--version"],
			["-v"],
			["--help", "--no-extensions"],
			["--help", "--mode", "json"],
			["-p", "--help"],
			["--list-models"],
			["--list-models", "gpt"],
			["--list-tips"],
			["--export", "session.jsonl"],
			["install", "extension"],
			["remove", "extension"],
			["uninstall", "extension"],
			["update"],
			["list"],
			["host", "status"],
			["schedule", "list"],
			["config", "--help"],
		].map((args) => ({ args })),
	)("does not enable or publish a cache for print-then-exit argv $args", async ({ args }) => {
		process.argv = ["node", "cli.ts", ...args];

		await enableStartupCompileCache();

		expect(enableCompileCache).not.toHaveBeenCalled();
		expect(process.env.NODE_COMPILE_CACHE).toBeUndefined();
	});

	test.each(
		[
			[],
			["-p", "hello"],
			["--mode", "rpc"],
			["app-server"],
			["config"],
			["--", "--list-tips"],
			["--system-prompt", "--list-tips"],
			["--append-system-prompt", "--help"],
			["--extension", "--list-models"],
			["--name", "--export"],
		].map((args) => ({ args })),
	)("enables and publishes a cache for session argv $args", async ({ args }) => {
		process.argv = ["node", "cli.ts", ...args];

		await enableStartupCompileCache();

		expect(enableCompileCache).toHaveBeenCalledOnce();
		expect(process.env.NODE_COMPILE_CACHE).toBe("/compile-cache");
	});
});
