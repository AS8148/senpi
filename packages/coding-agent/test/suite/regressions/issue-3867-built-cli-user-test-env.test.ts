import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

// senpi#3869 review: the agent-dir guard must stay inert for a user's own process, even one that
// looks like a test run (NODE_ENV=test from Jest/bun test, VITEST from a Vitest worker).
const builtCli = fileURLToPath(new URL("../../../dist/cli.js", import.meta.url));
const builtConfig = fileURLToPath(new URL("../../../dist/config.js", import.meta.url));
const userTestEnv = { NODE_ENV: "test", VITEST: "true", PI_OFFLINE: "1", PI_SKIP_RUNTIME_NOTICE: "1" };
const runTempEnv = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };

describe("the built CLI under a user's test-looking environment (#3867)", () => {
	let home: string | undefined;

	afterEach(() => {
		if (home) rmSync(home, { recursive: true, force: true });
		home = undefined;
	});

	it("starts and answers an RPC request with a real-looking HOME and no senpi test env", async () => {
		home = mkdtempSync(join(tmpdir(), "senpi-user-home-"));
		mkdirSync(join(home, ".senpi", "agent"), { recursive: true });
		const child = spawn(process.execPath, [builtCli, "--mode", "rpc", "--no-session"], {
			cwd: home,
			env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...runTempEnv, ...userTestEnv },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const response = new Promise<Record<string, unknown>>((resolve, reject) => {
			const lines = createInterface({ input: child.stdout });
			lines.on("line", (line) => {
				if (!line.includes('"id":"state"')) return;
				resolve(JSON.parse(line) as Record<string, unknown>);
			});
			child.once("exit", (code) => reject(new Error(`CLI exited with ${code} before answering:\n${stderr}`)));
		});
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
		try {
			expect(await response).toMatchObject({ id: "state", type: "response", success: true });
		} finally {
			child.stdin.end();
			child.kill();
			await exited;
		}
		expect(stderr).not.toContain("RealAgentDirInTestError");
	});

	it("resolves the real account home's agent dir without throwing (resolution only, nothing written)", () => {
		const realHome = userInfo().homedir;
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const m = await import(${JSON.stringify(builtConfig)}); process.stdout.write(m.getAgentDir());`,
			],
			{ env: { PATH: process.env.PATH, HOME: realHome, USERPROFILE: realHome, ...runTempEnv, ...userTestEnv }, encoding: "utf8" },
		);

		expect(probe.stderr).not.toContain("RealAgentDirInTestError");
		expect(probe.status).toBe(0);
		expect(probe.stdout.startsWith(realHome)).toBe(true);
	});
});
