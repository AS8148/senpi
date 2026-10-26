import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/tool-call-middleware/recovery-stream-wrapper.ts";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../../src/types.ts";
import {
	type AssistantRecord,
	assistantRecords,
	carryAssistantCapture,
	getAssistantCapture,
	isAssistantProgress,
	pushAssistantProgress,
} from "../../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import { SERVER_FALLBACK_ABORTED_DIAGNOSTIC } from "../../src/utils/server-fallback-receipt.ts";
import {
	drainRecords,
	publicEvents,
	recordsOnForeignBlocks,
	subscribeCaptureForEachTest,
} from "../producer-capture-records.ts";
import { createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

subscribeCaptureForEachTest();

const tool = { name: "Bash", description: "fixture", parameters: Type.Object({ command: Type.String() }) };
const nativeArguments = '{"command":"echo native"}';
const fallbackReceipt = { type: "fallback", from: { model: "a" }, to: { model: "b" } };

type Ending = "done" | "superseded" | "aborted" | "failure" | "fallback-aborted";

/** Signed thinking at 0, a native call at 1 and plain text at 2: every outer index equals its source index. */
function nativeCallTurn(ending: Ending): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const output = createAssistantMessage([], "pending");
	stream.push({ type: "start", partial: output });
	const thinking: ThinkingContent = { type: "thinking", thinking: "plan" };
	output.content.push(thinking);
	stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
	stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
	const call: ToolCall = { type: "toolCall", id: "native", name: "Bash", arguments: {} };
	output.content.push(call);
	stream.push({ type: "toolcall_start", contentIndex: 1, partial: output });
	call.arguments = { command: "echo native" };
	stream.push({ type: "toolcall_delta", contentIndex: 1, delta: nativeArguments, partial: output });
	pushAssistantProgress(stream, {
		type: "message_tool_arguments_reset",
		contentIndex: 1,
		rawArgumentPrefix: nativeArguments,
		parsedThrough: nativeArguments.length,
	});
	stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: output });
	const text: TextContent = { type: "text", text: "" };
	output.content.push(text);
	stream.push({ type: "text_start", contentIndex: 2, partial: output });
	text.text = "after";
	stream.push({ type: "text_delta", contentIndex: 2, delta: "after", partial: output });
	stream.push({ type: "text_end", contentIndex: 2, content: "after", partial: output });
	endTurn(stream, output, ending);
	return stream;
}

function endTurn(stream: AssistantMessageEventStream, output: AssistantMessage, ending: Ending): void {
	if (ending === "failure") {
		// A delta for a call that already ended is an invalid native order.
		stream.push({ type: "toolcall_delta", contentIndex: 1, delta: "", partial: output });
	} else if (ending === "aborted") {
		output.stopReason = "aborted";
		stream.push({ type: "error", reason: "aborted", error: output });
	} else if (ending === "fallback-aborted") {
		// Its own message: the live partials the wrapper has not read yet must keep their blocks.
		const diagnostics = [{ type: SERVER_FALLBACK_ABORTED_DIAGNOSTIC, timestamp: 0, details: {} }];
		const error: AssistantMessage = { ...output, content: [], stopReason: "error", diagnostics };
		stream.push({ type: "error", reason: "error", error });
		stream.end(error);
		return;
	} else {
		// A receipt appended without an event supersedes every client tool call before it.
		if (ending === "superseded")
			output.content.push({ type: "providerNative", subtype: "fallback", raw: fallbackReceipt });
		output.stopReason = "toolUse";
		stream.push({ type: "done", reason: "toolUse", message: output });
	}
	stream.end(output);
}

function terminalOf(events: AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "done" | "error" }> {
	const terminal = events.at(-1);
	if (terminal?.type !== "done" && terminal?.type !== "error") throw new Error("no terminal event");
	return terminal;
}

function terminalContent(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>): AssistantMessage {
	return event.type === "done" ? event.message : event.error;
}

function carryingRecords(records: AssistantRecord[]): AssistantRecord[] {
	return records.filter((record) => isAssistantProgress(record) || getAssistantCapture(record) !== undefined);
}

/** The reader rule a terminal's `rewrittenFrom` sets: records for that index and above are dropped. */
function keptByReader(records: AssistantRecord[], rewrittenFrom: number | undefined): AssistantRecord[] {
	return carryingRecords(records).filter((record) => {
		if (rewrittenFrom === undefined || !("contentIndex" in record)) return true;
		const index = isAssistantProgress(record)
			? record.contentIndex
			: (getAssistantCapture(record)?.contentIndex ?? record.contentIndex);
		return index < rewrittenFrom;
	});
}

describe("recovery terminals that rewrite content mark the records they invalidate #4272", () => {
	it("marks nothing when the terminal keeps every block at its index", async () => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(nativeCallTurn("done"), [tool]));
		const terminal = terminalOf(publicEvents(records));
		expect(terminalContent(terminal).content.map((block) => block.type)).toEqual(["thinking", "toolCall", "text"]);
		expect(getAssistantCapture(terminal)?.rewrittenFrom).toBeUndefined();
		expect(recordsOnForeignBlocks(carryingRecords(records), terminalContent(terminal))).toEqual([]);
	});

	// Each terminal drops the call at outer 1, so the text at 2 moves to 1 and index 2 names nothing.
	it.each([
		["an aborted source", "aborted", 1],
		["a receipt that supersedes the call", "superseded", 1],
		["an invalid native order", "failure", 1],
		["a forwarded fallback abort with no content", "fallback-aborted", 0],
	] as const)("marks the first moved index on the terminal of %s", async (_label, ending, rewrittenFrom) => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(nativeCallTurn(ending), [tool]));
		const terminal = terminalOf(publicEvents(records));
		const content = terminalContent(terminal);
		expect(recordsOnForeignBlocks(carryingRecords(records), content)).not.toEqual([]);
		expect(getAssistantCapture(terminal)?.rewrittenFrom).toBe(rewrittenFrom);
		expect(recordsOnForeignBlocks(keptByReader(records, rewrittenFrom), content)).toEqual([]);
	});

	it("keeps the mark when a later wrapper or the agent re-carries the terminal onto its own message", async () => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(nativeCallTurn("aborted"), [tool]));
		const terminal = terminalOf(publicEvents(records));
		const message = terminalContent(terminal);
		const carried = carryAssistantCapture(terminal, { type: "message_end", message }, message);
		expect(getAssistantCapture(carried)?.rewrittenFrom).toBe(1);
	});

	it("marks the first moved index on the terminal a cancelled consumer leaves behind", async () => {
		const wrapped = wrapStreamWithInvokeRecovery(nativeCallTurn("done"), [tool]);
		const iterator = assistantRecords(wrapped)[Symbol.asyncIterator]();
		const read: AssistantRecord[] = [];
		for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
			read.push(next.value);
			if (next.value.type === "text_start") break;
		}
		await iterator.return?.();
		const rest: AssistantRecord[] = [];
		for await (const record of assistantRecords(wrapped)) rest.push(record);
		const terminal = terminalOf(publicEvents(rest));
		const content = terminalContent(terminal);
		expect(content.content.map((block) => block.type)).toEqual(["thinking", "text"]);
		expect(recordsOnForeignBlocks(carryingRecords(read), content)).not.toEqual([]);
		expect(getAssistantCapture(terminal)?.rewrittenFrom).toBe(1);
		expect(recordsOnForeignBlocks(keptByReader(read, 1), content)).toEqual([]);
	});
});
