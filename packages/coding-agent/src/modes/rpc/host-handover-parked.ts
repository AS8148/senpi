/**
 * The handoff-parked residency record: the set of sessions a predecessor host held resident and
 * parked with `handoff_parked` (or its idle sweep), persisted so the SUCCESSOR can reopen them by
 * path with the same durable session id (senpi#3282).
 *
 * A `retain_on_disconnect` session must survive EVERY generation. The predecessor appends one entry
 * per parked session at the drain/idle park, AWAITED and serialized through an in-process mutex so
 * concurrent parks never lose an update (read-merge-write without a lock loses them). The successor
 * reads the record, reopens each entry with the same durable id and `retain_on_disconnect`, and
 * removes it ONLY after a successful reopen - a crash between the two leaves the entry for the next
 * generation (at most once, never lost). An entry whose session file no longer exists is dropped,
 * never retried.
 *
 * One file per endpoint (`<daemonDir>/handover-parked.json`), written atomically (writeJsonAtomic)
 * so a reader sees the previous or the new content, never a torn file.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonObject, writeJsonAtomic } from "./host-state-json.ts";

export interface HandoverParkedEntry {
	readonly sessionPath: string;
	readonly durableSessionId?: string;
	readonly retainOnDisconnect: boolean;
	readonly cwd?: string;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
}

const recordFile = (daemonDir: string): string => join(daemonDir, "handover-parked.json");

/**
 * In-process serialization of every read-merge-write. `writeJsonAtomic` prevents a torn file, not a
 * lost update: two parks that read the same old list and write back would drop one. Chaining every
 * mutation on this promise makes each read see the previous write's result.
 */
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

async function readEntries(daemonDir: string): Promise<HandoverParkedEntry[]> {
	const record = await readJsonObject(recordFile(daemonDir));
	const sessions = record?.sessions;
	if (!Array.isArray(sessions)) return [];
	return sessions.filter(isEntry);
}

async function writeEntries(daemonDir: string, entries: readonly HandoverParkedEntry[]): Promise<void> {
	await mkdir(daemonDir, { recursive: true, mode: 0o700 });
	await writeJsonAtomic(recordFile(daemonDir), { version: 1, sessions: entries });
}

export function recordHandoverParkedSession(daemonDir: string, entry: HandoverParkedEntry): Promise<void> {
	return enqueueMutation(async () => {
		const existing = await readEntries(daemonDir);
		if (existing.some((row) => row.sessionPath === entry.sessionPath)) return;
		await writeEntries(daemonDir, [...existing, entry]);
	});
}

export async function readHandoverParkedSessions(daemonDir: string): Promise<readonly HandoverParkedEntry[]> {
	return readEntries(daemonDir);
}

export function clearHandoverParkedSession(daemonDir: string, sessionPath: string): Promise<void> {
	return enqueueMutation(async () => {
		const remaining = (await readEntries(daemonDir)).filter((row) => row.sessionPath !== sessionPath);
		await writeEntries(daemonDir, remaining);
	});
}

export function dropHandoverParkedSessionIfFileGone(daemonDir: string, sessionPath: string): Promise<void> {
	if (existsSync(sessionPath)) return Promise.resolve();
	return clearHandoverParkedSession(daemonDir, sessionPath);
}

export function clearHandoverParkedSessions(daemonDir: string): Promise<void> {
	return enqueueMutation(() => writeEntries(daemonDir, []));
}
