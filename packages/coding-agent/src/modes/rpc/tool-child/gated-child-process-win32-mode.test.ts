// senpi#3566 todo 4 (Windows half): on win32 every gated child_process launch is contained by the job and reports the
// command it started, so the server can record creation-time membership. Runs on every OS with the platform injected.
import realChildProcess from "node:child_process";
import { describe, expect, it } from "vitest";
import { BarrierClock } from "./barrier-clock.ts";
import { createGatedChildProcess } from "./gated-child-process.ts";
import { TOOL_CHILD_REENTRY_ENV } from "./launch-shim-role.ts";
import { WorkerLaunchClient, type WorkerLaunchMessage } from "./worker-launch.ts";

function recordingClient() {
	const messages: WorkerLaunchMessage[] = [];
	const client = new WorkerLaunchClient({
		clockBuffer: BarrierClock.create().buffer,
		post: (message) => messages.push(message),
		jobId: () => "job-1",
		skipAckWait: true,
	});
	return { client, messages };
}

describe("gated child_process in win32 mode", () => {
	it("records job containment and reports the started pid for spawnSync", () => {
		const { client, messages } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32");
		const result = cp.spawnSync("true");
		const launch = messages.find((message) => message.kind === "launch");
		expect(launch?.kind === "launch" ? launch.request.containment : undefined).toBe("job");
		expect(messages.filter((message) => message.kind === "started")).toEqual([
			{ kind: "started", launchId: launch?.launchId, pid: result.pid, breakaway: false },
		]);
	});

	it("reports the started pid for spawn", async () => {
		const { client, messages } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32");
		const child = cp.spawn("true", [], { stdio: "ignore" });
		await new Promise((resolveExit) => child.once("exit", resolveExit));
		expect(messages.find((message) => message.kind === "started")).toMatchObject({ pid: child.pid });
	});

	it("fails typed when a detached launch has no re-entry command for the shim", () => {
		const { client } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32");
		const saved = process.env[TOOL_CHILD_REENTRY_ENV];
		delete process.env[TOOL_CHILD_REENTRY_ENV];
		try {
			expect(() => cp.spawn("true", [], { detached: true })).toThrow(/^tool_child_breakaway_failed: /);
		} finally {
			if (saved !== undefined) process.env[TOOL_CHILD_REENTRY_ENV] = saved;
		}
	});

	it("starts a detached launch through the shim, as breakaway, and reports the pid the shim wrote on fd 3", async () => {
		const { client, messages } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32");
		const stubShim = 'require("node:fs").writeSync(3, JSON.stringify({ pid: 4321 }) + "\\n")';
		const saved = process.env[TOOL_CHILD_REENTRY_ENV];
		process.env[TOOL_CHILD_REENTRY_ENV] = JSON.stringify({ command: process.execPath, args: ["-e", stubShim] });
		try {
			const shim = cp.spawn("cmd.exe", ["/c", "exit 0"], { detached: true, stdio: "ignore" });
			await new Promise((resolveExit) => shim.once("exit", resolveExit));
		} finally {
			if (saved === undefined) delete process.env[TOOL_CHILD_REENTRY_ENV];
			else process.env[TOOL_CHILD_REENTRY_ENV] = saved;
		}
		expect(messages.find((message) => message.kind === "launch")).toMatchObject({
			request: { api: "cp.spawn", containment: "breakaway", lifetime: "detached" },
		});
		expect(messages.find((message) => message.kind === "started")).toMatchObject({ pid: 4321, breakaway: true });
	});

	it("keeps POSIX launches inherited with no started report", () => {
		const { client, messages } = recordingClient();
		createGatedChildProcess(realChildProcess, client, "darwin").spawnSync("true");
		expect(messages.find((message) => message.kind === "launch")).toMatchObject({
			request: { containment: "inherited" },
		});
		expect(messages.some((message) => message.kind === "started")).toBe(false);
	});
});
