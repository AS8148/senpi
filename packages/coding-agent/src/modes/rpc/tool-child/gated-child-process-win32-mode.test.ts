// senpi#3566 todo 4 (Windows half): on win32 every gated child_process launch is contained by the job and reports the
// command it started, so the server can record creation-time membership. Runs on every OS with the platform injected.
import realChildProcess from "node:child_process";
import { describe, expect, it } from "vitest";
import { BarrierClock } from "./barrier-clock.ts";
import { createGatedChildProcess } from "./gated-child-process.ts";
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
			{ kind: "started", launchId: launch?.launchId, pid: result.pid },
		]);
	});

	it("reports the started pid for spawn", async () => {
		const { client, messages } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32");
		const child = cp.spawn("true", [], { stdio: "ignore" });
		await new Promise((resolveExit) => child.once("exit", resolveExit));
		expect(messages.find((message) => message.kind === "started")).toMatchObject({ pid: child.pid });
	});

	it("refuses a detached launch until the breakaway shim exists", () => {
		const { client } = recordingClient();
		const cp = createGatedChildProcess(realChildProcess, client, "win32");
		expect(() => cp.spawn("true", [], { detached: true })).toThrow(/^tool_child_breakaway_unavailable: /);
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
