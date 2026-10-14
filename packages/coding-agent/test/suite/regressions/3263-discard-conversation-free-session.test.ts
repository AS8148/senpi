import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";

// senpi#3263: a TUI session writes its header at startup (control endpoint), and extensions then
// append custom entries (rules scan, memory binding). Closing without chatting must still remove
// the file, because the session holds no user or assistant message - the same rule that keeps a
// new session in memory until its first message (#10000).

let dir: string | undefined;
afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function startedSession(): { manager: SessionManager; file: string } {
	dir = mkdtempSync(join(tmpdir(), "senpi-3263-"));
	const manager = SessionManager.create(dir, dir);
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("no session file");
	return { manager, file };
}

describe("closing a session without a conversation leaves no file (#3263)", () => {
	it("discards a header-only file that extensions added custom entries to", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("pi-rules.scan", { rules: [] });
		manager.appendCustomEntry("senpi-memory.session-binding", { agent: "test" });
		expect(existsSync(file)).toBe(true);

		expect(await manager.discardHeaderOnlyFile()).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(manager.isTranscriptFlushed()).toBe(false);
	});

	it("keeps the file once the session has a user message", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("pi-rules.scan", { rules: [] });
		manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("keeps the file once the session has an assistant message", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendMessage(fauxAssistantMessage("reply"));

		expect(await manager.discardHeaderOnlyFile()).toBe(false);
		expect(existsSync(file)).toBe(true);
	});

	it("writes the buffered custom entries again once a conversation starts after the discard", async () => {
		const { manager, file } = startedSession();
		await manager.persistHeaderNow();
		manager.appendCustomEntry("pi-rules.scan", { rules: [] });
		await manager.discardHeaderOnlyFile();

		manager.appendMessage({ role: "user", content: "later", timestamp: Date.now() });
		expect(existsSync(file)).toBe(true);
		const reopened = SessionManager.open(file, dir);
		expect(reopened.getEntries().map((entry) => entry.type)).toEqual(["custom", "message"]);
	});
});
