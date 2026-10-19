/**
 * `move_session` (senpi#3676): the RPC commands a transport and the clients use to drive a session move between two
 * hosts. Two in-process rigs stand in for two devices (each with its own agent directory, so its own move ledger and
 * session folders), and two git checkouts of one repository stand in for the user's working copies.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPOSITORY_IDENTITY_ENTRY_TYPE } from "../../src/core/repository-identity.ts";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { SessionMovedAwayError } from "../../src/core/session-move/ownership.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { SESSION_ID } from "./session-move-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

type Rig = ReturnType<typeof createInProcessRig>;
type MoveFields = Record<string, unknown> & { readonly op: string };

async function devices() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "senpi-rpc-move-")));
	dirs.push(base);
	const repoA = join(base, "a", "repo");
	mkdirSync(repoA, { recursive: true });
	git(repoA, "init", "-q");
	git(repoA, "commit", "-q", "--allow-empty", "-m", "root");
	const repoB = join(base, "b", "repo");
	git(base, "clone", "-q", repoA, repoB);
	const root = git(repoA, "rev-list", "--max-parents=0", "HEAD");
	const agentA = join(base, "agent-a");
	const agentB = join(base, "agent-b");
	const sessionPath = join(getDefaultSessionDir(repoA, agentA), `2026-10-19T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const lines = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-10-19T00:00:00.000Z", cwd: repoA },
		{
			type: "custom",
			id: "r1",
			parentId: null,
			timestamp: "2026-10-19T00:00:00.500Z",
			customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
			data: { rootCommits: [root] },
		},
		{
			type: "message",
			id: "u1",
			parentId: "r1",
			timestamp: "2026-10-19T00:00:01.000Z",
			message: { role: "user", content: "remember 42", timestamp: 1 },
		},
	];
	writeFileSync(sessionPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return { base, repoA, repoB, agentA, agentB, sessionPath };
}

async function move(rig: Rig, fields: MoveFields): Promise<Record<string, unknown>> {
	const response = await rig.router.handle({ type: "move_session", id: "mv", ...fields } as RpcCommand);
	await rig.settle();
	if (response === undefined) throw new Error("move_session answered nothing");
	return { ...response };
}

async function hostAndRelease(rig: Rig, cwd: string, sessionPath: string, moveId: string) {
	const session = opened(await rig.open("conn-a", { cwd, sessionPath, retain_on_disconnect: true }), 0);
	await rig.drop("conn-a");
	const released = await rig.router.handle({
		type: "release_session",
		id: "rel",
		sessionId: session.sessionId,
		reason: "move",
		moveId,
		target: "device-b",
	});
	await rig.settle();
	return { session, released };
}

const customTypes = (file: string) =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { customType?: string })
		.map((entry) => entry.customType)
		.filter((type) => type?.startsWith("session_"));

describe("move_session over RPC (senpi#3676)", () => {
	it("#given two hosts #then ready, release, export, import, status and finish move the session to B under the same id", async () => {
		const { repoA, repoB, agentA, agentB, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await using b = createInProcessRig(agentB);

		expect(await move(b, { op: "prepare", moveId: "move-1" })).toMatchObject({
			success: true,
			command: "move_session",
			data: { state: "ready", expires_at: expect.any(String) },
		});
		const { released } = await hostAndRelease(a, repoA, sessionPath, "move-1");
		expect(released).toMatchObject({ success: true });

		const exported = await move(a, {
			op: "export",
			sessionPath,
			moveId: "move-1",
			target: "device-b",
			droppedUserMessages: ["queued follow-up"],
		});
		expect(exported).toMatchObject({ success: true, data: { move_id: "move-1", session_id: SESSION_ID } });
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;
		expect(existsSync(join(bundleDir, "manifest.json"))).toBe(true);
		expect(bundleDir.startsWith(agentA)).toBe(true);

		const imported = await move(b, { op: "import", bundleDir, cwd: repoB, from: "device-a" });
		expect(imported).toMatchObject({ success: true, data: { session_id: SESSION_ID } });
		const onB = (imported.data as { session_path: string }).session_path;
		expect(onB.startsWith(agentB)).toBe(true);
		expect(readFileSync(onB, "utf8")).toContain("remember 42");
		expect(() =>
			SessionManager.open(onB).appendMessage({ role: "user", content: "on B", timestamp: 2 }),
		).not.toThrow();

		const status = await move(b, { op: "status", moveId: "move-1" });
		expect(status).toMatchObject({ success: true, data: { state: "accepted" } });

		expect(
			await move(a, { op: "finish", sessionPath, moveId: "move-1", answer: { state: "accepted" } }),
		).toMatchObject({ success: true, data: { ownership: "moved" } });
		expect(customTypes(sessionPath)).toEqual(["session_released", "session_moved"]);
		expect(existsSync(bundleDir)).toBe(false);
		expect(() =>
			SessionManager.open(sessionPath).appendMessage({ role: "user", content: "late", timestamp: 3 }),
		).toThrow(SessionMovedAwayError);
	});

	it("#given a session that was not released for this move #then export refuses it and seals nothing", async () => {
		const { repoA, agentA, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		const session = opened(await a.open("conn-a", { cwd: repoA, sessionPath, retain_on_disconnect: true }), 0);

		const hosted = await move(a, { op: "export", sessionPath, moveId: "move-2", target: "device-b" });
		expect(hosted).toMatchObject({ success: false, error: "session_open_here" });
		await a.router.handle({ type: "close_session", id: "c", sessionId: session.sessionId });
		await a.settle();

		const unreleased = await move(a, { op: "export", sessionPath, moveId: "move-2", target: "device-b" });
		expect(unreleased).toMatchObject({ success: false, error: "move_not_released" });
		expect(customTypes(sessionPath)).toEqual([]);
	});

	it("#given a bundle for a move B never readied #then the import is refused and B is fenced for that move", async () => {
		const { repoA, repoB, agentA, agentB, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await using b = createInProcessRig(agentB);
		await hostAndRelease(a, repoA, sessionPath, "move-3");
		const exported = await move(a, { op: "export", sessionPath, moveId: "move-3", target: "device-b" });
		const bundleDir = (exported.data as { bundle_dir: string }).bundle_dir;

		expect(await move(b, { op: "import", bundleDir, cwd: repoB })).toMatchObject({
			success: false,
			error: "move_fenced",
			errorData: { detail: expect.any(String) },
		});
		expect(await move(b, { op: "status", moveId: "move-3" })).toMatchObject({
			success: true,
			data: { state: "declined", reason: "chunk_without_ready" },
		});
	});

	it("#given B cancelled #when A finishes with the decline #then A takes the session back with its queued input", async () => {
		const { repoA, agentA, agentB, sessionPath } = await devices();
		await using a = createInProcessRig(agentA);
		await using b = createInProcessRig(agentB);
		await move(b, { op: "prepare", moveId: "move-4" });
		await hostAndRelease(a, repoA, sessionPath, "move-4");
		await move(a, {
			op: "export",
			sessionPath,
			moveId: "move-4",
			target: "device-b",
			droppedUserMessages: ["keep me"],
		});

		const cancelled = await move(b, { op: "cancel", moveId: "move-4" });
		expect(cancelled).toMatchObject({ success: true, data: { state: "declined", reason: "cancelled" } });
		const answer = (await move(b, { op: "status", moveId: "move-4" })).data;

		expect(await move(a, { op: "finish", sessionPath, moveId: "move-4", answer })).toMatchObject({
			success: true,
			data: { ownership: "writable" },
		});
		expect(customTypes(sessionPath)).toEqual(["session_released", "session_reclaimed"]);
		expect(readFileSync(sessionPath, "utf8")).toContain("keep me");
	});

	it("#given a move id that is not a plain id or an unknown op #then the command is refused before touching anything", async () => {
		const { agentB } = await devices();
		await using b = createInProcessRig(agentB);
		for (const moveId of ["../x", "", "a/b"]) {
			expect(await move(b, { op: "prepare", moveId })).toMatchObject({
				success: false,
				error: "invalid_move_request",
			});
		}
		expect(await move(b, { op: "teleport", moveId: "m" })).toMatchObject({
			success: false,
			error: "invalid_move_request",
		});
		expect(existsSync(join(agentB, "session-moves", "ledger", "..json"))).toBe(false);
	});
});
