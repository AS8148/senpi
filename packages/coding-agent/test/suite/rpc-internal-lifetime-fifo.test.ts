import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { armHostWatchdog, readHostWatchdogConfig } from "../../src/modes/rpc/host-watchdog.ts";

const roots: string[] = [];
const writers: number[] = [];
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const fd of writers.splice(0)) {
		try {
			closeSync(fd);
		} catch {}
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A lifetime FIFO with a live writer, the way the supervisor holds one. */
function lifetimeFifo(): { path: string; writer: number } {
	const root = mkdtempSync("/tmp/r3816f-");
	roots.push(root);
	const path = join(root, "lifetime.fifo");
	execFileSync("mkfifo", ["-m", "600", path]);
	const writer = openSync(path, constants.O_RDWR);
	writers.push(writer);
	return { path, writer };
}

// senpi#3816 round 7 (lead ruling: FIFO): supervisor death reaches the host as an event on Linux and macOS.
describe.skipIf(process.platform === "win32")("FIFO lifetime binding", () => {
	it.each(["node", "bun"])(
		"%s fires within 1 s of the last writer closing",
		async (runtime) => {
			const fifo = lifetimeFifo();
			const host = spawn(
				runtime,
				[
					...(runtime === "bun" ? [] : ["--import", "tsx"]),
					join(import.meta.dirname, "rpc-internal-lifetime-fifo-harness.ts"),
				],
				{
					env: {
						...process.env,
						SENPI_RPC_HOST_WATCH_PPID: String(process.pid),
						SENPI_RPC_HOST_LIFETIME_FIFO: fifo.path,
					},
					stdio: ["ignore", "ignore", "inherit", "ipc"],
				},
			);
			try {
				const [armed] = await once(host, "message");
				expect(armed).toEqual({ type: "armed" });
				const fired = once(host, "message");
				const started = performance.now();
				closeSync(fifo.writer);
				writers.splice(writers.indexOf(fifo.writer), 1);
				const [message] = await fired;
				expect(message).toMatchObject({ type: "fired" });
				expect(performance.now() - started).toBeLessThan(1_000);
			} finally {
				if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
			}
		},
		20_000,
	);

	it("an idle host bound by the FIFO makes no liveness wakes in 10 s (one long backstop only)", async () => {
		const fifo = lifetimeFifo();
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const stop = armHostWatchdog(
			readHostWatchdogConfig({
				SENPI_RPC_HOST_WATCH_PPID: "4242",
				SENPI_RPC_HOST_WATCH_PSTART_TICKS: "123456",
				SENPI_RPC_HOST_LIFETIME_FIFO: fifo.path,
			}),
			vi.fn(),
		);
		try {
			await vi.advanceTimersByTimeAsync(10_000);
			expect(kill.mock.calls.filter(([pid, signal]) => pid === 4242 && signal === 0)).toHaveLength(0);
		} finally {
			stop();
		}
	});
});
