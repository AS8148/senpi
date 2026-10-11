import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, expect, it, vi } from "vitest";
import { buildCompactionContext } from "../../src/core/extensions/builtin/compaction/context-pipeline.ts";
import * as frontier from "../../src/core/extensions/builtin/compaction/context-reduction-frontier.ts";
import { createContextReductionState } from "../../src/core/extensions/builtin/compaction/context-reduction-state.ts";
import { createEmergencyPruneLatch } from "../../src/core/extensions/builtin/compaction/emergency-prune.ts";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	vi.restoreAllMocks();
	harness?.cleanup();
	harness = undefined;
});

it.each([false, true])("checks the emergency valve without an anchor when engagement is %s", async (engaged) => {
	harness = await createHarness();
	const state = { ...createContextReductionState(), engaged };
	const latch = createEmergencyPruneLatch();
	const messages: AgentMessage[] = [{ role: "user", content: "unprunable ".repeat(50_000), timestamp: 0 }];
	// Hold the earlier frontier decision fixed: this test owns the independent
	// post-prune valve, not the frontier's separately tested ceiling guard.
	vi.spyOn(frontier, "reduceContextWithFrontier").mockImplementation((messages) => messages);
	const outgoing = buildCompactionContext({
		event: { type: "context", messages },
		ctx: harness.getExtensionRunner().createContext(),
		contextWindow: 100_000,
		promptContextWindow: 96_000,
		contextReductionState: state,
		contextOverheadTokens: 1_000,
		toolAdmissionEnabled: false,
		breakerFallback: false,
		laneOwnsCompaction: false,
		emergencyPruneLatch: latch,
	});
	expect(latch.engaged).toBe(true);
	expect(outgoing).toEqual(messages);
	expect(estimateTotalTokens(outgoing)).toBeGreaterThan(96_000);
	expect(state.anchorCount).toBeUndefined();
	expect(state.compactionRequired === true).toBe(engaged);
});

it("requires recovery for an actual prune even before frontier engagement", async () => {
	harness = await createHarness();
	const state = createContextReductionState();
	const messages: AgentMessage[] = [
		{ role: "user", content: "old ".repeat(120_000), timestamp: 0 },
		{ role: "user", content: "Current request", timestamp: 1 },
	];
	vi.spyOn(frontier, "reduceContextWithFrontier").mockImplementation((messages) => messages);
	const outgoing = buildCompactionContext({
		event: { type: "context", messages },
		ctx: harness.getExtensionRunner().createContext(),
		contextWindow: 100_000,
		promptContextWindow: 96_000,
		contextReductionState: state,
		toolAdmissionEnabled: false,
		breakerFallback: false,
		laneOwnsCompaction: false,
		emergencyPruneLatch: createEmergencyPruneLatch(),
	});
	expect(state.engaged).toBe(false);
	expect(state.anchorCount).toBeUndefined();
	expect(estimateTotalTokens(outgoing)).toBeLessThan(96_000);
	expect(outgoing).not.toEqual(messages);
	expect(state.compactionRequired).toBe(true);
});
