// The QA fixture tools' bodies as the tool child runs them (senpi#3566 todo 4): each export receives the `module` job's
// `{ params, toolCallId }` and returns a tool result. `qa_hostcall` has no body here: it needs `ctx.executeTool`, which
// reaches the child only with the reverse bridge (todo 7).
import { setTimeout as delay } from "node:timers/promises";
import { blobText, mutateFile, raiseSegv, sinkDigest } from "../qa-tools-extension.ts";
import { type SpawnFixtureParams, spawnFixture } from "./spawn-fixture.ts";

interface ChildInput<P> {
	readonly params: P;
	readonly toolCallId: string;
}

const controlDir = (): string => process.env.SENPI_TOOL_CHILD_TEST_CONTROL_DIR ?? process.cwd();

function result(text: string, details: unknown) {
	return { content: [{ type: "text", text }], details };
}

export async function qa_sleep({ params }: ChildInput<{ ms: number }>) {
	await delay(params.ms);
	return result(`slept ${params.ms}ms`, { ms: params.ms, pid: process.pid });
}

export function qa_blob({ params }: ChildInput<{ bytes: number }>) {
	return result(blobText(params.bytes), { bytes: params.bytes, pid: process.pid });
}

export function qa_sink({ params }: ChildInput<{ payload: string }>) {
	const digest = sinkDigest(params.payload);
	return result(digest, { sha256: digest, bytes: Buffer.byteLength(params.payload, "utf8"), pid: process.pid });
}

export async function qa_spawn({ params, toolCallId }: ChildInput<SpawnFixtureParams>) {
	const launchId = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_");
	const spawned = await spawnFixture(params, { controlDir: controlDir(), launchId });
	return result(JSON.stringify(spawned), { launchId, ...spawned, pid: process.pid });
}

export async function qa_mutate({ params }: ChildInput<{ path: string; line: string }>) {
	const suspend = process.env.SENPI_TOOL_CHILD_TEST_SUSPEND_WRITE !== undefined;
	await mutateFile(params, { suspend, controlDir: controlDir() });
	return result(`appended to ${params.path}`, { suspended: suspend, pid: process.pid });
}

export function qa_segv() {
	raiseSegv({
		kill: (pid, signal) => process.kill(pid, signal),
		exit: (code) => process.exit(code),
		platform: process.platform,
	});
	return result("qa_segv returned without terminating", { pid: process.pid });
}
