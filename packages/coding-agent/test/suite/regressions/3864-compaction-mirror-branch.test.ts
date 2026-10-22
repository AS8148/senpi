import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, expect, it } from "vitest";
import type { SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

function isUserEntry(entry: { type: string; message?: { role: string } }): entry is SessionMessageEntry {
	return entry.type === "message" && entry.message?.role === "user";
}

// senpi#3864: an invisible entry kept before an edited prompt must not pull the abandoned branch back in.
it("keeps messages abandoned by an edit out of the compacted mirror", async () => {
	// Given "first" -> "one", an invisible note, then "second" -> "two" written after that note.
	const harness = await createHarness({
		persistSession: true,
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "summary before the edit",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				}));
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await harness.session.prompt("first");
	harness.sessionManager.appendCustomEntry("extension-note", { seq: 1 });
	await harness.session.prompt("second");
	const second = harness.sessionManager.getEntries().filter(isUserEntry)[1];
	if (!second) throw new Error("expected the second prompt");

	// When that prompt is edited (abandoning "second" -> "two") and the session is compacted.
	await harness.session.editUserMessage(second.id, "second, edited", { summarize: false });
	await harness.session.compact();

	// Then the live messages match the persisted context: summary plus the edited prompt only.
	const context = harness.sessionManager.buildSessionContext().messages;
	expect(context.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
	expect(getMessageText(context[1])).toBe("second, edited");
	expect(harness.session.messages.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
	expect(harness.session.messages.map((message) => getMessageText(message))).not.toContain("two");
});
