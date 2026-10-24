import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { LifecycleSessionBinding } from "../../../src/core/lifecycle-session-binding.ts";
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

it("writes no lifecycle record after dispose when an in-flight compaction unwinds", async () => {
	// Given a settled session whose manual compaction is still writing its summary.
	const h = await settledSession();
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
			return fauxAssistantMessage("Summary of the conversation.");
		},
		fauxAssistantMessage("Summary of the turn prefix."),
	]);
	const compaction = h.session.compact().catch(() => undefined);
	await started;
	const append = vi.spyOn(h.session.sessionManager, "appendCustomEntry");

	// When the session is disposed and the compaction then unwinds.
	h.session.dispose();
	releaseSummary();
	await compaction;

	// Then nothing appended a lifecycle record to the released session file.
	expect(append.mock.calls.filter(([type]) => type === "session-lifecycle")).toEqual([]);
});

it("writes no lifecycle or custody record after dispose through the idle and turn-end paths", async () => {
	// Given a session whose run is in flight, waiting on its model reply.
	const h = await createHarness();
	harnesses.push(h);
	let releaseReply!: () => void;
	const replyHeld = new Promise<void>((resolve) => {
		releaseReply = resolve;
	});
	let replyStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		replyStarted = resolve;
	});
	h.setResponses([
		async () => {
			replyStarted();
			await replyHeld;
			return fauxAssistantMessage("Reply.");
		},
	]);
	void h.session.prompt("Request").catch(() => undefined);
	await started;
	const binding = (h.session as unknown as { _lifecycleBinding: LifecycleSessionBinding })._lifecycleBinding;

	// When the session is disposed and the run's end then reaches the two older write paths: the deferred-turn idle
	// (controller.idle) and the extension agent_end (binding.turnEnded).
	h.session.dispose();
	const append = vi.spyOn(h.session.sessionManager, "appendCustomEntry");
	binding.controller.idle();
	await binding.turnEnded({ type: "agent_end", messages: [] });
	releaseReply();

	// Then nothing appended a lifecycle, child or custody record to the released session file.
	expect(
		append.mock.calls.filter(
			([type]) => type === "session-lifecycle" || type === "work-custody" || type === "child-lifecycle",
		),
	).toEqual([]);
});
