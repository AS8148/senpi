import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import type { Harness } from "../harness.ts";
import { createBoundLifecycleHarness as createHarness, runToAgentIdle } from "../lifecycle-test-harness.ts";

// senpi#4120 review: the lifecycle is no longer recomputed on read, so every fact that clears must raise its own
// edge. Compaction and branch summarization hold the session-work barrier and an abort controller past their
// end events; the state must follow them when they are released.
const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
});

async function settledSession(): Promise<Harness> {
	// keepRecentTokens: 1 so two short turns are enough to compact.
	const h = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
	harnesses.push(h);
	h.setResponses([fauxAssistantMessage("Reply 1."), fauxAssistantMessage("Reply 2.")]);
	await runToAgentIdle(h, () => h.session.prompt("Request 1"));
	await runToAgentIdle(h, () => h.session.prompt("Request 2"));
	expect(h.session.lifecycle.state).toBe("done");
	return h;
}

it("returns to its prior state after a manual compaction with no run", async () => {
	// Given a settled session.
	const h = await settledSession();
	h.setResponses([
		fauxAssistantMessage("Summary of the conversation."),
		fauxAssistantMessage("Summary of the turn prefix."),
	]);

	// When the person compacts it manually.
	await h.session.compact();

	// Then the state a client reads is the settled one again, without anything else happening.
	expect(h.session.lifecycle.state).toBe("done");
});

it("returns to its prior state after a manual compaction whose summary fails", async () => {
	// Given a settled session whose summarization request fails.
	const h = await settledSession();
	h.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" }),
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "summary failed" }),
	]);

	// When the person compacts it manually and the compaction fails.
	await h.session.compact().catch(() => undefined);

	// Then the state is the settled one again.
	expect(h.session.lifecycle.state).toBe("done");
});

it("reads running while a branch summary is written and settles when it ends", async () => {
	// Given a settled session with an earlier branch point.
	const h = await settledSession();
	const target = h.session.sessionManager.getEntries().find((entry) => entry.type === "message");
	if (!target) throw new Error("expected a message entry to navigate to");
	let releaseSummary!: () => void;
	const summaryHeld = new Promise<void>((resolve) => {
		releaseSummary = resolve;
	});
	let summaryStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		summaryStarted = resolve;
	});
	h.setResponses([
		async () => {
			summaryStarted();
			await summaryHeld;
			return fauxAssistantMessage("Branch summary.");
		},
	]);

	// When the person navigates the tree with a summary and the summary is still being written.
	const navigation = h.session.navigateTree(target.id, { summarize: true });
	await started;

	// Then a client reads running while it is written, and the settled state once it ends.
	expect(h.session.lifecycle.state).toBe("running");
	releaseSummary();
	await navigation;
	expect(h.session.lifecycle.state).toBe("done");
});
