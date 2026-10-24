import { expect, it, vi } from "vitest";
import { markMcpFormPresented, type McpFormInput } from "../../src/core/mcp-form-types.ts";
import { registerLocalMcpPresenter } from "../../src/modes/interactive/mcp-local-presenter.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";

function input(presentationSignal: AbortSignal): McpFormInput {
	return {
		operationId: "operation",
		inputId: "input",
		round: 0,
		message: "private-message",
		server: { label: "configured-server", source: "user" },
		schema: { type: "object", properties: {} },
		operationSignal: new AbortController().signal,
		presentationSignal,
		deadlineMs: 1000,
	};
}

it("the local presenter admits once after complete form review, not per primitive", async () => {
	const admission = vi.fn();
	const tui = mrtrTui(async (_title, choices, options) => {
		expect(admission).not.toHaveBeenCalled();
		markMcpFormPresented(options);
		return choices.includes("Submit") ? "Submit" : choices[0];
	});
	const lifetime = new AbortController();
	try {
		const presentation = registerLocalMcpPresenter(tui.ui, "session", lifetime.signal, admission).capture();
		if (!presentation) throw new Error("Missing local presenter");
		expect(await presentation.present(input(new AbortController().signal))).toMatchObject({
			kind: "result",
			result: { action: "accept", content: {} },
			source: "presenter_action",
			humanAdmission: true,
		});
		expect(admission).toHaveBeenCalledTimes(1);
		expect(tui.events).toEqual([]);
	} finally {
		lifetime.abort();
		tui.lose();
	}
});

it.each([false, true])("presentation loss uses actual rendered state (%s), never delivery", async (rendered) => {
	const started = Promise.withResolvers<void>();
	const tui = mrtrTui(
		(_title, _choices, options) =>
			new Promise((resolve) => {
				if (!options?.signal) throw new Error("Missing modal lifetime");
				options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
				if (rendered) markMcpFormPresented(options);
				started.resolve();
			}),
	);
	const lifetime = new AbortController();
	const lost = new AbortController();
	const admission = vi.fn();
	try {
		const presentation = registerLocalMcpPresenter(tui.ui, "session", lifetime.signal, admission).capture();
		if (!presentation) throw new Error("Missing local presenter");
		const result = presentation.present(input(lost.signal));
		await started.promise;
		lost.abort();
		expect(await result).toMatchObject(
			rendered
				? { kind: "result", result: { action: "cancel" }, humanAdmission: false }
				: { kind: "processing_failure", humanAdmission: false },
		);
		expect(admission).not.toHaveBeenCalled();
		expect(tui.events).toEqual([]);
	} finally {
		lifetime.abort();
		tui.lose();
	}
});
