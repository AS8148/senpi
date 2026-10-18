/**
 * The supervisor's own SCRATCH state: the private internal-hop directory, the record of its host child's
 * identity, and the boot settings it reads. Split out of `host-lifecycle-launch.ts` (senpi#2566).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessIdentity, readProcessStartTime, waitForStartTime } from "../../utils/process-identity.ts";
import { writeJsonAtomic } from "./host-state-json.ts";
import { errorMessage, supervisorLog } from "./host-supervisor-log.ts";

/**
 * The internal hop must stay short enough for sun_path (104 bytes on macOS)
 * regardless of where the public socket lives, and private against other local
 * users, so it gets its own 0700 directory under the OS temp directory.
 *
 * On win32 the directory lives under the caller-supplied rpc-host-daemon
 * directory, which ensureHost() creates but a direct --internal-rpc-host-supervisor
 * launch does not, so the parent is created recursively.
 */
export async function createInternalSocketPath(
	baseDir = tmpdir(),
	platform: NodeJS.Platform = process.platform,
): Promise<{ socket: string; dir?: string; secretPath?: string }> {
	if (platform === "win32") {
		const dir = join(baseDir, `internal-${randomUUID()}`);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return {
			socket: `\\\\.\\pipe\\senpi-rpc-internal-${randomUUID()}`,
			dir,
			secretPath: join(dir, "secret"),
		};
	}
	const dir = join(tmpdir(), `senpi-rpc-host-internal-${randomUUID().slice(0, 8)}`);
	await mkdir(dir, { recursive: false, mode: 0o700 });
	await writeFile(
		join(dir, ".owner"),
		JSON.stringify({
			pid: process.pid,
			processStartTime: await readProcessStartTime(process.pid),
			createdAt: Date.now(),
		}),
		{ mode: 0o600 },
	);
	return { socket: join(dir, "host.sock"), dir, secretPath: join(dir, ".secret") };
}

/** The bounded startup wait for the child's identity, then the one unhurried read (#3658). */
const CHILD_START_TIME_WAIT_MS = 10_000;
const CHILD_START_TIME_UNHURRIED_MS = 15_000;

async function readChildStartTime(pid: number, timeoutMs: number): Promise<string | undefined> {
	const identity = await readProcessIdentity(pid, process.platform, timeoutMs, undefined, "UTC");
	if (identity.kind === "error") throw identity.error;
	return identity.kind === "present" ? identity.identity : undefined;
}

/**
 * Best-effort, 0600, by rename; released with the generation directory.
 *
 * The pid is recorded at once and its start time added when it can be read, the way the supervisor's own
 * record is (`host-ensure-start.ts`): a bounded wait of 1 s probes, then one unhurried read. A single
 * 1 s CIM probe fired right after spawn came back empty on every Windows generation (#3658). An identity
 * read after the child exited is never recorded: its pid may already name an unrelated process.
 */
export async function recordChildPid(file: string, pid: number, running: () => boolean): Promise<void> {
	try {
		await writeJsonAtomic(file, { pid, processStartTime: null });
		const processStartTime =
			(await waitForStartTime(pid, CHILD_START_TIME_WAIT_MS, (p) => readChildStartTime(p, 1_000)).catch(
				() => undefined,
			)) ?? (await readChildStartTime(pid, CHILD_START_TIME_UNHURRIED_MS).catch(() => undefined));
		if (processStartTime === undefined) {
			supervisorLog(`host child pid ${pid} start time unreadable at recording`);
			return;
		}
		if (!running()) return;
		await writeJsonAtomic(file, { pid, processStartTime });
	} catch (cause) {
		supervisorLog(`could not record the host child pid: ${errorMessage(cause)}`);
	}
}

export async function readSettingsFile(settingsFile: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(settingsFile, "utf8"));
	} catch {
		return undefined;
	}
}
