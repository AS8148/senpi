import { describe, expect, it, vi } from "vitest";
import type { SessionStatusEntryView } from "../../src/modes/rpc/session-status.ts";
import { SessionStatusStream } from "../../src/modes/rpc/session-status-stream.ts";

describe("session status mirror view cost", () => {
	it("does not rebuild a view per delta when subscribers do not request mirroring", () => {
		// Given: a status-only subscription has already received its snapshot.
		const entry: SessionStatusEntryView = {
			state: "open",
			kind: "interactive",
			cwd: "/test",
			attachments: 1,
			context: {},
		};
		const view = vi.fn(() => ({ entry }));
		const entryView = vi.fn(() => entry);
		const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0 });
		stream.setSource({ sessionIds: () => ["rpc-1"], view, entryView });
		stream.subscribe("observer", {
			selector: { kind: "all" },
			includeWorkers: false,
			includeContext: false,
			mirror: { kind: "none" },
		});
		view.mockClear();
		entryView.mockClear();

		// When: the writer asks for destinations for successive content deltas.
		const targets = Array.from({ length: 3 }, () => stream.mirrorTargets("rpc-1", "message_update"));

		// Then: neither the runtime nor the entry view is rebuilt.
		expect(targets).toEqual([[], [], []]);
		expect(view).not.toHaveBeenCalled();
		expect(entryView).not.toHaveBeenCalled();
	});

	it("matches mirrored deltas using only the current entry view", () => {
		// Given: a child selector must use live context, not its snapshot context.
		const entry: SessionStatusEntryView = {
			state: "open",
			kind: "worker",
			cwd: "/test",
			attachments: 1,
			context: { parent_session_id: "old-parent" },
		};
		const view = vi.fn(() => ({ entry }));
		const entryView = vi.fn(() => ({ ...entry, context: { parent_session_id: "new-parent" } }));
		const stream = new SessionStatusStream({ enqueue: () => true, pendingQuestions: () => 0 });
		stream.setSource({ sessionIds: () => ["rpc-1"], view, entryView });
		stream.subscribe("observer", {
			selector: { kind: "childrenOf", parent: "new-parent" },
			includeWorkers: true,
			includeContext: false,
			mirror: { kind: "types", types: new Set(["message_update"]) },
		});
		view.mockClear();

		// When: a matching content delta arrives.
		const targets = stream.mirrorTargets("rpc-1", "message_update");

		// Then: live entry context routes it without building runtime state.
		expect(targets).toEqual(["observer"]);
		expect(view).not.toHaveBeenCalled();
		expect(entryView).toHaveBeenCalledOnce();
	});
});
