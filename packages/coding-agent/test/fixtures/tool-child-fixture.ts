// A real tool child for the lifecycle tests (senpi#3566 todo 4): the production entry with test-only job kinds.
import { connectChannel } from "../../src/modes/rpc/tool-child/channel.ts";
import { runToolChild, ToolChildJobError } from "../../src/modes/rpc/tool-child/entry.ts";
import { startGatedWorker } from "../../src/modes/rpc/tool-child/gated-worker.ts";
import { launchOwnGroup } from "../../src/modes/rpc/tool-child/launch-barrier.ts";

const mode = process.env.TOOL_CHILD_FIXTURE_MODE ?? "serve";

if (mode === "hang") {
	await connectChannel(process.env);
	setInterval(() => {}, 1_000);
} else if (mode === "exit") {
	process.exit(3);
} else if (mode === "bad-generation") {
	const channel = await connectChannel(process.env);
	channel.send({ type: "hello", generation: 999, pid: process.pid, protocol: 1 });
	setInterval(() => {}, 1_000);
} else {
	await runToolChild({
		handlers: {
			echo: async (args) => args,
			print: async () => {
				process.stdout.write("\u0000\u0000\u0000\u0005{not a frame}\n");
				return "printed";
			},
			sleep: (_args, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () =>
						reject(new ToolChildJobError("tool_child_cancelled", "cancelled")),
					);
				}),
			exit: async () => process.exit(3),
			workerSpawn: (_args, { jobId, gate }) =>
				new Promise((resolve, reject) => {
					const worker = startGatedWorker(gate, new URL("./tool-child-plain-worker.ts", import.meta.url), jobId);
					worker.on("message", (message: { kind?: string; status?: number }) => {
						if (message.kind !== "result") return;
						void worker.terminate();
						resolve({ status: message.status });
					});
					worker.once("error", reject);
				}),
			spawnSleep: async (_args, { jobId, gate }) => {
				const { child } = await launchOwnGroup({
					gate,
					jobId,
					origin: "tool",
					api: "cp.spawn",
					program: "/bin/sleep",
					args: ["300"],
				});
				return { pid: child.pid };
			},
		},
	});
}
