// Worker half of the gated Bun fixture (senpi#3566 todo 4).
import { parentPort, workerData } from "node:worker_threads";
import { type BunLaunchGlobals, installGatedBun } from "../../src/modes/rpc/tool-child/gated-bun.ts";
import { WorkerLaunchClient } from "../../src/modes/rpc/tool-child/worker-launch.ts";

declare const Bun: BunLaunchGlobals & {
	spawn(cmd: string[], options?: Record<string, unknown>): { pid: number; exited: Promise<number> };
};

const port = parentPort;
if (port === null) throw new Error("not a worker");
const { buffer } = workerData as { buffer: SharedArrayBuffer };
installGatedBun(
	Bun,
	new WorkerLaunchClient({ clockBuffer: buffer, post: (message) => port.postMessage(message), jobId: () => "job-1" }),
);
const owned = Bun.spawn(["sh", "-c", "ps -o pgid= -p $$"], { stdout: "pipe" }) as unknown as {
	pid: number;
	exited: Promise<number>;
	stdout: ReadableStream;
};
const ownedPgid = Number((await new Response(owned.stdout).text()).trim());
const ownedExit = await owned.exited;
const detachedExit = await Bun.spawn(["sh", "-c", "exit 0"], { detached: true }).exited;
const syncExit = Bun.spawnSync(["sh", "-c", "exit 4"]).exitCode;
const shell = (await (Bun.$`sh -c "exit 0"` as Promise<{ exitCode: number }>)).exitCode;
port.postMessage({
	kind: "result",
	value: { ownedPid: owned.pid, ownedPgid, ownedExit, detachedExit, syncExit, shell },
});
