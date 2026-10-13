/**
 * The handoff-parked residency record: the set of sessions a predecessor host held resident and
 * parked with `handoff_parked`, persisted so the SUCCESSOR can reopen them by path (senpi#3282).
 *
 * The predecessor appends one entry per parked session at the drain's park seam, before the public
 * socket moves. The successor reads the file on startup, reopens each entry with the same durable
 * session id and `retain_on_disconnect`, and removes it from the record ONLY after a successful
 * reopen - a crash between the two leaves the entry for the next generation, so a parked session
 * is reopened at most once and never lost. An entry whose session file is gone is logged and
 * dropped (nothing can reopen a dead path).
 *
 * One file per endpoint (`<daemonDir>/handover-parked.json`), written atomically (writeJsonAtomic)
 * so a reader sees the previous or the new content, never a torn file.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonObject, writeJsonAtomic } from "./host-state-json.ts";

export interface HandoverParkedEntry {
	readonly sessionPath: string;
	readonly durableSessionId?: string;
	readonly retainOnDisconnect: boolean;
	readonly model?: { readonly provider: string; readonly modelId: string };
	readonly thinkingLevel?: string;
}

const recordFile = (daemonDir: string): string => join(daemonDir, "handover-parked.json");

function isEntry(value: unknown): value is HandoverParkedEntry {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.sessionPath === "string" &&
		typeof record.retainOnDisconnect === "boolean" &&
		(record.durableSessionId === undefined || typeof record.durableSessionId === "string") &&
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

/** Append a parked session for the successor to reopen. Read-merge-write keeps concurrent parks. */
export async function recordHandoverParkedSession(daemonDir: string, entry: HandoverParkedEntry): Promise<void> {
	const existing = await readEntries(daemonDir);
	if (existing.some((row) => row.sessionPath === entry.sessionPath)) return;
	await writeEntries(daemonDir, [...existing, entry]);
}

/**
 * Read the parked set for the successor, and remove one entry after it was reopened. Removal is
 * read-merge-write against the CURRENT file, so a park that lands between the startup read and the
 * removal is not lost.
 */
export async function takeHandoverParkedSessions(daemonDir: string): Promise<readonly HandoverParkedEntry[]> {
	return readEntries(daemonDir);
}

export async function clearHandoverParkedSession(daemonDir: string, sessionPath: string): Promise<void> {
	const remaining = (await readEntries(daemonDir)).filter((row) => row.sessionPath !== sessionPath);
	await writeEntries(daemonDir, remaining);
}

/** Drop every entry at once (the whole set reopened, or the endpoint is being retired). */
export async function clearHandoverParkedSessions(daemonDir: string): Promise<void> {
	await writeEntries(daemonDir, []);
}
