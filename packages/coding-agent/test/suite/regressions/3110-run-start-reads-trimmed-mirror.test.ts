import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	captureAgentCheckpoint,
	getLatestCheckpoint,
	persistCheckpoint,
} from "../../../src/core/extensions/builtin/compaction/checkpoint-state.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import {
	type FileEntry,
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";

const LARGE_TEXT = "x".repeat(256 * 1024);

/**
 * senpi#3110: every run start reads the latest compaction checkpoint. On a reopened, compacted
 * session that read went through `getEntries()`, which re-parsed the whole transcript file and kept
 * it parsed until the session settled idle, so each busy task child pinned roughly four times its
 * transcript for the length of every run. The checkpoint sits on the current branch, which the
 * trimmed mirror already holds.
 */
describe("run-start checkpoint reads on a reopened compacted session (senpi#3110)", () => {
	let dir: string;
	let fullLoads: number;
	let restoreLoader: () => void;

	beforeEach(() => {
		dir = join(tmpdir(), `3110-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		fullLoads = 0;
		restoreLoader = setSessionEntryLoaderForTesting((file: string): FileEntry[] => {
			fullLoads++;
			return loadEntriesFromFile(file);
		});
	});

	afterEach(() => {
		restoreLoader();
		rmSync(dir, { recursive: true, force: true });
	});

	function reopenedCompactedSession(): SessionManager {
		const session = SessionManager.create(dir, dir);
		session.appendMessage(userMsg(`early ${LARGE_TEXT}`));
		session.appendCustomEntry("agent-meta", { agentName: "worker" });
		session.appendMessage(assistantMsg("early answer"));
		const firstKept = session.appendMessage(userMsg("kept"));
		session.appendMessage(assistantMsg("kept answer"));
		session.appendCompaction("summary", firstKept, 1000);
		persistCheckpoint(
			{ activeTools: ["read"], agentName: "worker", timestamp: 42 },
			{
				appendEntry: (customType, data) => void session.appendCustomEntry(customType, data),
			},
		);
		session.appendMessage(userMsg("after"));
		session.appendMessage(assistantMsg("after answer"));
		const reopened = SessionManager.open(session.getSessionFile() ?? "", dir);
		// The session settled idle once after its open, which drops the history the load parsed.
		reopened.dropMaterializedCaches();
		return reopened;
	}

	function contextOf(sessionManager: SessionManager): ExtensionContext {
		return { sessionManager, model: undefined } as unknown as ExtensionContext;
	}

	it("finds the latest checkpoint without re-reading the transcript file", () => {
		// Given: a reopened compacted session whose open-time history was released at idle.
		const reopened = reopenedCompactedSession();

		// When: the next run starts and looks up the latest checkpoint.
		const checkpoint = getLatestCheckpoint(contextOf(reopened));

		// Then: the checkpoint comes from the resident mirror and no full history is parsed or held.
		expect(checkpoint).toMatchObject({ activeTools: ["read"], agentName: "worker", timestamp: 42 });
		expect(fullLoads).toBe(0);
		expect(reopened.holdsMaterializedHistory()).toBe(false);
	});

	it("names the agent in a new checkpoint without re-reading the transcript file", () => {
		// Given: the same reopened session, compacting again.
		const reopened = reopenedCompactedSession();
		const pi = { getActiveTools: () => ["read"], getThinkingLevel: () => "off" } as unknown as ExtensionAPI;

		// When: the compaction captures the agent's state.
		const captured = captureAgentCheckpoint(pi, contextOf(reopened));

		// Then: the agent name comes from the resident branch.
		expect(captured.agentName).toBe("worker");
		expect(fullLoads).toBe(0);
		expect(reopened.holdsMaterializedHistory()).toBe(false);
	});
});
