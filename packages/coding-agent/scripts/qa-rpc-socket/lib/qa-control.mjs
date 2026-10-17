/**
 * Control-file helpers for held barrier states. The server and the child watch
 * `SENPI_TOOL_CHILD_TEST_CONTROL_DIR` with `fs.watch`; the driver releases a hold by creating the named
 * file. `releaseGate` unblocks a `qa_spawn{gate:true}` command: on POSIX it writes the command's FIFO
 * (`gate-<launchId>`), on Windows it signals `waitfor SenpiGate<launchId>`.
 */
import { execFile } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function createControl(controlDir, platform = process.platform) {
	const touch = (name) => writeFile(join(controlDir, name), "");
	return {
		dir: controlDir,
		releaseAck: (launchId) => touch(`release-${launchId}`),
		releaseHeartbeat: () => touch("release-heartbeat"),
		releaseProof: (launchId) => touch(`release-proof-${launchId}`),
		releaseWrite: () => touch("release-write"),
		async releaseGate(launchId) {
			if (platform === "win32") {
				await run("waitfor", ["/si", `SenpiGate${launchId}`]);
				return;
			}
			// Opening a FIFO for write completes once the gated command has it open for read.
			const fifo = await open(join(controlDir, `gate-${launchId}`), "w");
			try {
				await fifo.write("go\n");
			} finally {
				await fifo.close();
			}
		},
	};
}
