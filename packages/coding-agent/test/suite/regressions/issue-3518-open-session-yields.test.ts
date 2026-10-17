import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type {
	CreateAgentSessionRuntimeFactory,
	CreateAgentSessionRuntimeResult,
} from "../../../src/core/agent-session-runtime.ts";
import { setSliceClockForTesting } from "../../../src/core/event-loop-slicer.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { fakeSessionBase } from "../../helpers/fake-session-base.ts";

/**
 * senpi#3518: a multi-session host runs every session on one event loop, so opening a large
 * transcript must hand the loop back while it parses. Slicing is made deterministic with a
 * clock that advances one millisecond per read: the assertions count loop turns, never time.
 */

const ENTRY_COUNT = 2_000;
const dirs: string[] = [];
let restoreClock: (() => void) | undefined;

afterEach(() => {
	restoreClock?.();
	restoreClock = undefined;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "senpi-3518-"));
	dirs.push(dir);
	return dir;
}

function useSteppingClock(): void {
	let now = 0;
	restoreClock = setSliceClockForTesting(() => now++);
}

function writeTranscript(path: string, cwd: string): void {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "issue-3518", timestamp: "2026-10-17T00:00:00.000Z", cwd }),
	];
	let parentId: string | null = null;
	for (let index = 0; index < ENTRY_COUNT; index++) {
		const id = `entry-${index}`;
		const text = index === 7 ? "x".repeat(40 * 1024) : `message ${index}`;
		const role = index % 2 === 0 ? "user" : "assistant";
		const message =
			role === "user"
				? { role, content: [{ type: "text", text }], timestamp: index }
				: {
						role,
						content: [{ type: "text", text }],
						api: "faux",
						provider: "faux",
						model: "faux-1",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: index,
					};
		lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: "2026-10-17T00:00:00.000Z", message }));
		parentId = id;
		if (index === 100) lines.push("", "{not json");
	}
	// No trailing newline: the open must terminate the final entry before appending.
	writeFileSync(path, lines.join("\n"));
}

async function countLoopTurnsDuring<T>(work: () => Promise<T>): Promise<{ value: T; turns: number }> {
	let turns = 0;
	let running = true;
	const tick = (): void => {
		if (!running) return;
		turns++;
		setImmediate(tick);
	};
	setImmediate(tick);
	try {
		return { value: await work(), turns };
	} finally {
		running = false;
	}
}

function snapshot(manager: SessionManager) {
	return {
		sessionId: manager.getSessionId(),
		cwd: manager.getCwd(),
		leafId: manager.getLeafId(),
		entries: manager.getEntries(),
		context: manager.buildSessionContext(),
	};
}

describe("issue #3518: opening a large session yields to the event loop", () => {
	test("openAsync loads exactly what open loads, and hands the loop back while it parses", async () => {
		const dir = tempDir();
		const syncPath = join(dir, "sync.jsonl");
		const asyncPath = join(dir, "async.jsonl");
		writeTranscript(syncPath, dir);
		writeTranscript(asyncPath, dir);
		const expected = snapshot(SessionManager.open(syncPath));

		useSteppingClock();
		const { value: manager, turns } = await countLoopTurnsDuring(() => SessionManager.openAsync(asyncPath));

		expect(turns).toBeGreaterThanOrEqual(ENTRY_COUNT / 10);
		const actual = snapshot(manager);
		expect(actual).toEqual(expected);
		expect(actual.entries).toHaveLength(ENTRY_COUNT);
		manager.appendMessage({ role: "user", content: [{ type: "text", text: "after reopen" }], timestamp: 1 });
		expect(SessionManager.open(asyncPath).getEntries()).toHaveLength(ENTRY_COUNT + 1);
	});

	test("openAsync matches open for a missing, an empty and a non-session file", async () => {
		const dir = tempDir();
		const missing = await SessionManager.openAsync(join(dir, "missing.jsonl"), undefined, dir, { id: "caller-id" });
		expect(missing.getSessionId()).toBe("caller-id");
		expect(missing.getEntries()).toEqual([]);

		writeFileSync(join(dir, "empty.jsonl"), "");
		const empty = await SessionManager.openAsync(join(dir, "empty.jsonl"), undefined, dir, { id: "empty-id" });
		expect(empty.getSessionId()).toBe("empty-id");

		writeFileSync(join(dir, "other.jsonl"), '{"type":"message","id":"a"}\n');
		await expect(SessionManager.openAsync(join(dir, "other.jsonl"))).rejects.toThrow(/not a valid .* session/);
		expect(() => SessionManager.open(join(dir, "other.jsonl"))).toThrow(/not a valid .* session/);
	});

	test("the RPC host's open_session loads a transcript in slices instead of holding the loop", async () => {
		const dir = tempDir();
		const sessionPath = join(dir, "host.jsonl");
		writeTranscript(sessionPath, dir);
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			new ProjectTrustStore(options.agentDir).set(options.cwd, true);
			return {
				session: {
					...fakeSessionBase(options),
					extensionRunner: { hasHandlers: () => false, emit: async () => {} },
					abort: async () => {},
					abortBash: () => {},
					waitForIdle: async () => {},
					dispose: () => {},
				},
				services: { cwd: options.cwd, agentDir: options.agentDir },
				diagnostics: [],
			} as unknown as CreateAgentSessionRuntimeResult;
		};
		const registry = new RpcSessionRegistry({ agentDir: dir, createRuntime });

		useSteppingClock();
		const { value: opened, turns } = await countLoopTurnsDuring(() =>
			registry.openSession({ cwd: dir, sessionPath, permissionPreset: "default" }),
		);

		expect(opened.durableSessionId).toBe("issue-3518");
		expect(turns).toBeGreaterThanOrEqual(ENTRY_COUNT / 10);
		await registry.close(opened.sessionId);
	});
});
