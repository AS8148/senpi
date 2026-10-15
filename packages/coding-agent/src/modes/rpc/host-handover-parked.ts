/**
 * The handoff-parked residency record: the set of sessions a predecessor host held resident and
 * parked with `handoff_parked` (or its idle sweep), persisted so the SUCCESSOR can reopen them by
 * path with the same durable session id (senpi#3282).
 *
 * A `retain_on_disconnect` session must survive EVERY generation. Each parked session is ONE file
 * (`<daemonDir>/handover-parked/<sha>.json`) written atomically, so a successor removes exactly the
 * entry it reopened and nothing else - a predecessor that parks another session concurrently cannot
 * be clobbered by that removal, across processes. This per-entry shape is the cross-process guard:
 * there is no shared list file to read-merge-write, so there is no lost update to lock against.
 * The predecessor appends an entry (awaited, in-process mutex so two parks in one host keep both);
 * the successor reopens each entry with the same durable id and `retain_on_disconnect` and deletes
 * ONLY that entry's file after success (crash-safe, at most once, never lost). An entry whose
 * session file is gone is dropped, never retried.
 */
import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HandoverParkedEntry {
	readonly sessionPath: string;
	readonly durableSessionId?: string;
	readonly retainOnDisconnect: boolean;
	readonly cwd?: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
}

const recordDir = (daemonDir: string): string => join(daemonDir, "handover-parked");

const entryFile = (daemonDir: string, sessionPath: string): string =>
	join(recordDir(daemonDir), `${createHash("sha256").update(sessionPath, "utf8").digest("hex").slice(0, 16)}.json`);

let mutationChain: Promise<void> = Promise.resolve();

function enqueueMutation(mutation: () => Promise<void>): Promise<void> {
	const next = mutationChain.then(mutation, mutation);
	mutationChain = next.catch(() => {});
	return next;
}

function isEntry(value: unknown): value is HandoverParkedEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.sessionPath === "string" &&
		typeof record.retainOnDisconnect === "boolean" &&
		(record.durableSessionId === undefined || typeof record.durableSessionId === "string") &&
		(record.cwd === undefined || typeof record.cwd === "string") &&
		(record.thinkingLevel === undefined || typeof record.thinkingLevel === "string") &&
		(record.model === undefined ||
			(typeof record.model === "object" &&
				record.model !== null &&
				typeof (record.model as Record<string, unknown>).provider === "string" &&
				typeof (record.model as Record<string, unknown>).modelId === "string"))
	);
}

async function writeEntryFile(daemonDir: string, entry: HandoverParkedEntry): Promise<void> {
	await mkdir(recordDir(daemonDir), { recursive: true, mode: 0o700 });
	const file = entryFile(daemonDir, entry.sessionPath);
	const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
	await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
}

export function recordHandoverParkedSession(daemonDir: string, entry: HandoverParkedEntry): Promise<void> {
	return enqueueMutation(() => writeEntryFile(daemonDir, entry));
}

export async function readHandoverParkedSessions(daemonDir: string): Promise<readonly HandoverParkedEntry[]> {
	let names: string[];
	try {
		names = (await readdir(recordDir(daemonDir))).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const entries: HandoverParkedEntry[] = [];
	for (const name of names) {
		const file = join(recordDir(daemonDir), name);
		try {
			const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
			if (isEntry(parsed)) entries.push(parsed);
			// A well-formed JSON value that fails the shape check is not corrupt: it may be an entry a
			// different-version generation wrote (a rollback handover). Leave it alone.
		} catch (cause) {
			// Writes are atomic (renameSync), so a torn write cannot happen; only a genuinely corrupt
			// payload (SyntaxError) is dropped. ENOENT is a normal race with a concurrent clear, and
			// EMFILE/EACCES are transient - dropping an entry for any of those loses a retained session
			// for good. On any of those, skip the entry and leave the file for the next read.
			if (cause instanceof SyntaxError) {
				process.stderr.write(`senpi rpc handover-parked entry ${name} is corrupt; dropping it\n`);
				await rm(file, { force: true });
			}
		}
	}
	return entries;
}

export function clearHandoverParkedSession(daemonDir: string, sessionPath: string): Promise<void> {
	return enqueueMutation(() => rm(entryFile(daemonDir, sessionPath), { force: true }));
}

export function dropHandoverParkedSessionIfFileGone(daemonDir: string, sessionPath: string): Promise<void> {
	if (existsSync(sessionPath)) return Promise.resolve();
	return clearHandoverParkedSession(daemonDir, sessionPath);
}
