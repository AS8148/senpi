/**
 * `--tool-runtime in-process|child` (senpi#3566): the flag, its `SENPI_TOOL_RUNTIME` fallback, the
 * startup error for an unknown value, and the `tool_runtime:<value>` capability a real host
 * advertises. Guards a CLI flag + protocol capability contract that later clients negotiate on.
 */
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { resolveToolRuntime } from "../../src/cli/tool-runtime.ts";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	generationScratch,
	JsonlPeer,
	reapProcessesUnder,
	supervisorLaunch,
} from "../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { assertWorkspaceBuildPrerequisite } from "../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const cliPath = resolve(import.meta.dirname, "../../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(import.meta.dirname, "../../src/experimental/source-resolver.ts")).href;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 120_000);

describe("resolveToolRuntime", () => {
	it("defaults to in-process with neither the flag nor the env set", () => {
		expect(resolveToolRuntime(parseArgs([]), {})).toEqual({ ok: true, value: "in-process" });
	});

	it("takes the flag, then the env, and the flag beats the env", () => {
		expect(resolveToolRuntime(parseArgs(["--tool-runtime", "child"]), {})).toEqual({ ok: true, value: "child" });
		expect(resolveToolRuntime(parseArgs([]), { SENPI_TOOL_RUNTIME: "child" })).toEqual({ ok: true, value: "child" });
		expect(resolveToolRuntime(parseArgs(["--tool-runtime", "in-process"]), { SENPI_TOOL_RUNTIME: "child" })).toEqual(
			{ ok: true, value: "in-process" },
		);
	});

	it("rejects an unknown value from either source, naming both kinds", () => {
		const parsed = parseArgs(["--tool-runtime", "bogus"]);
		expect(parsed.toolRuntime).toBeUndefined();
		expect(parsed.diagnostics).toContainEqual({ type: "error", message: "--tool-runtime must be in-process or child" });
		const fromEnv = resolveToolRuntime(parseArgs([]), { SENPI_TOOL_RUNTIME: "bogus" });
		expect(fromEnv.ok).toBe(false);
		expect(fromEnv.ok ? "" : fromEnv.message).toMatch(/in-process or child/);
	});
});

describe("tool runtime at startup", () => {
	it("rejects an unknown tool runtime and exits non-zero before serving", async () => {
		const flag = await runCli(["--mode", "rpc", "--multi-session", "--tool-runtime", "bogus"], {});
		expect(flag.code).not.toBe(0);
		expect(flag.stderr).toContain("--tool-runtime must be in-process or child");
		const env = await runCli(["--mode", "rpc", "--multi-session"], { SENPI_TOOL_RUNTIME: "bogus" });
		expect(env.code).not.toBe(0);
		expect(env.stderr).toContain("tool-runtime");
		expect(env.stderr).toContain("in-process or child");
	}, 60_000);

	it.each([
		{ hostArgs: [], expected: "tool_runtime:in-process" },
		{ hostArgs: ["--tool-runtime", "child"], expected: "tool_runtime:child" },
	])("ensureHost advertises tool_runtime ($expected)", async ({ hostArgs, expected }) => {
		const qa = generationScratch("toolrt");
		const peers: JsonlPeer[] = [];
		cleanups.push(async () => {
			for (const peer of peers) peer.destroy();
			await reapProcessesUnder(qa.root);
			await rm(qa.root, { recursive: true, force: true });
		});
		writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
		const host = await ensureHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			hostArgs: [...GENERATION_HOST_ARGS, ...hostArgs],
			env: generationEnv(qa),
			policy: { idleExitMs: 600_000 },
			_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
		});
		host.release();
		const client = await JsonlPeer.connect(qa.socket);
		peers.push(client);
		const info = await client.request({ id: "info", type: "get_protocol_info" });
		const capabilities = (info.data as { capabilities?: unknown } | undefined)?.capabilities;
		expect(capabilities).toContain(expected);
		expect(Array.isArray(capabilities) ? capabilities.filter((c) => String(c).startsWith("tool_runtime:")) : []).toEqual(
			[expected],
		);
	}, 120_000);
});

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const scratch = generationScratch("toolrt-cli");
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd: scratch.cwd,
			env: { ...process.env, ...generationEnv(scratch), SENPI_CODING_AGENT_DIR: scratch.agentDir, ...env },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("close", (code) => {
			void rm(scratch.root, { recursive: true, force: true }).then(() => resolvePromise({ code, stderr }), reject);
		});
	});
}
