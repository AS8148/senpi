import { expect, it, vi } from "vitest";
import { formatModelAnswer } from "../../src/core/extensions/builtin/ask-user/format.ts";
import { ConnectionQuestionBridge, degradeQuestion } from "../../src/modes/rpc/connection-question-bridge.ts";

// sisyphuslabs/omo-desktop-app#4042: an ask cancelled or timed out after the user had answered part
// of it must show the model those answers and the questions left open, not a bare dismissal.
const request = {
	requestId: "tool-1",
	waitForAnswer: true,
	timeoutMs: 60_000,
	questions: ["q1", "q2"].map((id) => ({
		id,
		header: id,
		question: id,
		options: [{ label: "A" }, { label: "B" }],
		multiSelect: false,
	})),
};
const modelText = (response: Parameters<typeof formatModelAnswer>[0]) =>
	formatModelAnswer(response, request.requestId, request.questions).text;

const abortAfterDraft = async (reason?: string) => {
	const bridge = new ConnectionQuestionBridge(() => {});
	const controller = new AbortController();
	const answer = bridge.ask(request, { signal: controller.signal });
	const id = bridge.pendingQuestions()[0].id;
	bridge.progress({ type: "extension_ui_progress", id, answers: { q1: { selected: ["A"] } } });
	controller.abort(reason);
	return answer;
};

it("shows the answered question and the unanswered rest when a structured ask is cancelled", async () => {
	const response = await abortAfterDraft();
	expect(response.status).toBe("cancelled");
	expect(modelText(response)).toBe(
		"The user cancelled the question after answering part of it.\nq1: A\nUnanswered: q2",
	);
});

it("shows the answered question and the unanswered rest when a structured ask times out", async () => {
	const response = await abortAfterDraft("timed_out");
	expect(response.status).toBe("timed_out");
	const text = modelText(response);
	expect(text).toContain("q1: A");
	expect(text).toContain("Unanswered: q2");
});

it("keeps the dismissal text for a cancelled ask with no answers", async () => {
	const bridge = new ConnectionQuestionBridge(() => {});
	const controller = new AbortController();
	const answer = bridge.ask(request, { signal: controller.signal });
	controller.abort();
	expect(modelText(await answer)).toBe("The user dismissed the question.");
});

it("shows the fallback's partial answer when the degraded ask is aborted after the first question", async () => {
	const controller = new AbortController();
	const select = vi
		.fn()
		.mockResolvedValueOnce("A")
		.mockImplementationOnce(async () => {
			controller.abort();
			return undefined;
		});
	const response = await degradeQuestion({ select, input: vi.fn() }, request, { signal: controller.signal });
	expect(response.status).toBe("cancelled");
	expect(modelText(response)).toBe(
		"The user cancelled the question after answering part of it.\nq1: A\nUnanswered: q2",
	);
});

it("opens no input when the signal aborts as the fallback select returns Other", async () => {
	const controller = new AbortController();
	const select = vi.fn().mockImplementationOnce(async () => {
		controller.abort();
		return "Other (type an answer)";
	});
	const input = vi.fn();
	const response = await degradeQuestion({ select, input }, request, { signal: controller.signal });
	expect(input).not.toHaveBeenCalled();
	expect(select).toHaveBeenCalledTimes(1);
	expect(response).toStrictEqual({ status: "cancelled", answers: {}, unanswered: ["q1", "q2"] });
});
