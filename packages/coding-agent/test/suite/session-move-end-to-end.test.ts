import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPOSITORY_IDENTITY_ENTRY_TYPE, type RepositoryIdentity } from "../../src/core/repository-identity.ts";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { importMovedSession, MoveRefusedError } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import {
	type MoveId,
	SESSION_MOVED,
	SESSION_MOVED_IN,
	SESSION_RECLAIMED,
	SessionMovedAwayError,
} from "../../src/core/session-move/ownership.ts";
import { finishMove } from "../../src/core/session-move/finish.ts";

const SESSION_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
const REPO: RepositoryIdentity = { rootCommits: ["d".repeat(40)] };
const OTHER: RepositoryIdentity = { rootCommits: ["e".repeat(40)] };
const MOVE = "move-0001" as MoveId;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-")));
	dirs.push(dir);
	return dir;
}

function writeSession(cwd: string): string {
	const sessionDir = getDefaultSessionDir(cwd);
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `2026-10-18T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-18T00:00:00.000Z", cwd },
		{ type: "custom", id: "r1", parentId: null, timestamp: "2026-10-18T00:00:00.500Z", customType: REPOSITORY_IDENTITY_ENTRY_TYPE, data: REPO },
		{
			type: "message",
			id: "u1",
			parentId: "r1",
			timestamp: "2026-10-18T00:00:01.000Z",
			message: { role: "user", content: "remember 42", timestamp: 1 },
		},
	];
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	const goal = join(sessionDir, "extensions", "goal", `${SESSION_ID}.json`);
	mkdirSync(dirname(goal), { recursive: true });
	writeFileSync(goal, '{"goal":"ship"}\n');
	return file;
}

function customTypes(file: string): string[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; customType?: string })
		.filter((entry) => entry.type === "custom")
		.map((entry) => entry.customType ?? "")
		.filter((customType) => customType.startsWith("session_"));
}

function admittedInputs(file: string): string[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { customType?: string; data?: { input?: { clientMessageId?: string; text?: string }; result?: { outcome?: string } } })
		.filter((entry) => entry.customType === "pending_input_transition" && entry.data?.result?.outcome === "admitted")
		.map((entry) => entry.data?.input?.text ?? "");
}

function appendUserMessage(file: string, text: string): void {
	SessionManager.open(file).appendMessage({ role: "user", content: text, timestamp: 3 });
}

async function setup(identity: RepositoryIdentity = REPO) {
	const base = root();
	const cwdA = join(base, "a", "repo");
	const cwdB = join(base, "b", "repo");
	mkdirSync(cwdA, { recursive: true });
	mkdirSync(cwdB, { recursive: true });
	const source = writeSession(cwdA);
	const bundleDir = join(base, "bundle");
	await exportSessionForMove({
		sessionFile: source,
		moveId: MOVE,
		target: "device-b",
		droppedUserMessages: ["queued follow-up"],
		bundleDir,
	});
	const ledger = new MoveLedger(join(base, "ledger-b"));
	const readIdentity = async (dir: string) => (dir === cwdB ? identity : REPO);
	return { base, cwdA, cwdB, source, bundleDir, ledger, readIdentity };
}

describe("session move between two folders", () => {
	it("#given an exported session #then A is read-only and the bundle carries the file, sidecars and dropped input", async () => {
		const { source, bundleDir } = await setup();
		expect(() => appendUserMessage(source, "after export")).toThrow(SessionMovedAwayError);
		expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);
	});

	it("#given a same-repository import #then B owns the session under the same id, with sidecars and the queued input", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const { sessionFile } = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

		expect(dirname(sessionFile)).toBe(getDefaultSessionDir(cwdB));
		expect(basename(sessionFile)).toContain(SESSION_ID);
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0] ?? "") as { cwd: string; id: string };
		expect(header).toMatchObject({ id: SESSION_ID, cwd: cwdB });
		expect(customTypes(sessionFile).at(-1)).toBe(SESSION_MOVED_IN);
		expect(admittedInputs(sessionFile)).toEqual(["queued follow-up"]);
		expect(existsSync(join(dirname(sessionFile), "extensions", "goal", `${SESSION_ID}.json`))).toBe(true);
		expect(() => appendUserMessage(sessionFile, "on B")).not.toThrow();
		expect(await ledger.answerStatus(MOVE, { movedIn: true })).toEqual({ state: "accepted" });
	});

	it("#given the same bundle imported twice #then the second import changes nothing", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const first = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		const before = readFileSync(first.sessionFile, "utf8");
		const second = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		expect(second.sessionFile).toBe(first.sessionFile);
		expect(readFileSync(second.sessionFile, "utf8")).toBe(before);
	});

	it("#given an import that crashed after its rename but before the ledger recorded it #when it runs again #then the move is recorded accepted", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		rmSync(ledger.dir, { recursive: true, force: true });
		await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given a different repository at B #then the import is refused with a reason and nothing lands at B", async () => {
		const { cwdB, source, bundleDir, ledger, readIdentity } = await setup(OTHER);
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toMatchObject({
			code: "move_repository_mismatch",
		});
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
			MoveRefusedError,
		);
		expect(existsSync(join(getDefaultSessionDir(cwdB), basename(source)))).toBe(false);
	});

	it("#given a tampered bundle #then the import fails and B records failed", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const file = join(bundleDir, "files", "session.jsonl");
		writeFileSync(file, `${readFileSync(file, "utf8")}{"tampered":true}\n`);
		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toMatchObject({
			code: "move_bundle_invalid",
		});
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "failed", reason: "bundle_invalid" });
	});

	it("#given B accepted #when A finishes #then A records session_moved and stays read-only", async () => {
		const { source, cwdB, bundleDir, ledger, readIdentity } = await setup();
		await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		await finishMove({ sessionFile: source, bundleDir, answer: { state: "accepted" } });
		expect(customTypes(source).at(-1)).toBe(SESSION_MOVED);
		expect(() => appendUserMessage(source, "still here")).toThrow(SessionMovedAwayError);
		expect(existsSync(bundleDir)).toBe(false);
	});

	it("#given B declined #when A finishes #then A reclaims, its queued input is back, and A may write again", async () => {
		const { source, bundleDir } = await setup();
		await finishMove({ sessionFile: source, bundleDir, answer: { state: "declined", reason: "no_record" } });
		expect(customTypes(source).at(-1)).toBe(SESSION_RECLAIMED);
		expect(admittedInputs(source)).toEqual(["queued follow-up"]);
		expect(() => appendUserMessage(source, "back on A")).not.toThrow();
		expect(existsSync(bundleDir)).toBe(false);
	});

	it("#given a reclaim that crashed before deleting its bundle #when it runs again #then the input is queued once", async () => {
		const { base, source, bundleDir } = await setup();
		const answer = { state: "declined", reason: "no_record" } as const;
		const kept = join(base, "bundle-kept");
		cpSync(bundleDir, kept, { recursive: true });
		await finishMove({ sessionFile: source, bundleDir, answer });
		cpSync(kept, bundleDir, { recursive: true });
		await finishMove({ sessionFile: source, bundleDir, answer });
		expect(admittedInputs(source)).toEqual(["queued follow-up"]);
	});
});
