import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { wrapStreamWithInvokeRecovery } from "../../src/tool-call-middleware/recovery-stream-wrapper.ts";
import type { ProviderNativeContent, TextContent, ThinkingContent, ToolCall } from "../../src/types.ts";
import { getAssistantCapture, pushAssistantProgress } from "../../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../../src/utils/event-stream.ts";
import {
	deltaCaptures,
	drainRecords,
	firstEvent,
	progressRecords,
	publicBytes,
	publicEvents,
	recordKinds,
	recordsOnForeignBlocks,
	subscribeCaptureForEachTest,
} from "../producer-capture-records.ts";
import { createAssistantMessage } from "./invoke-recovery-stream-fixtures.ts";

subscribeCaptureForEachTest();

const tool = { name: "Bash", description: "fixture", parameters: Type.Object({ command: Type.String() }) };
const invoke = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
const prose = `before ${invoke} after`;
const nativeArguments = '{"command":"echo native"}';
const searchInProgress = { type: "providerNative", subtype: "web_search_call", raw: { status: "in_progress" } };
const completedSearch = { type: "providerNative", subtype: "web_search_call", raw: { status: "completed" } };

function bufferedProviderTurn(captureBlocks: boolean): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream({ captureBlocks });
	const output = createAssistantMessage([], "pending");
	stream.push({ type: "start", partial: output });
	const thinking: ThinkingContent = { type: "thinking", thinking: "" };
	output.content.push(thinking);
	stream.push({ type: "thinking_start", contentIndex: 0, partial: output });
	thinking.thinking = "plan";
	stream.push({ type: "thinking_delta", contentIndex: 0, delta: "plan", partial: output });
	thinking.thinkingSignature = "sig";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" });
	stream.push({ type: "thinking_end", contentIndex: 0, content: "plan", partial: output });
	const text: TextContent = { type: "text", text: "" };
	output.content.push(text);
	stream.push({ type: "text_start", contentIndex: 1, partial: output });
	text.text = prose;
	stream.push({ type: "text_delta", contentIndex: 1, delta: prose, partial: output });
	text.textSignature = "t1";
	pushAssistantProgress(stream, { type: "message_block_metadata", contentIndex: 1, textSignature: "t1" });
	stream.push({ type: "text_end", contentIndex: 1, content: prose, partial: output });
	const native: ProviderNativeContent = {
		type: "providerNative",
		subtype: "web_search_call",
		raw: { status: "in_progress" },
	};
	output.content.push(native);
	pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 2, phase: "insert", block: native });
	native.raw = { status: "completed" };
	pushAssistantProgress(stream, { type: "message_block_state", contentIndex: 2, phase: "end", block: native });
	const call: ToolCall = { type: "toolCall", id: "native", name: "Bash", arguments: {} };
	output.content.push(call);
	stream.push({ type: "toolcall_start", contentIndex: 3, partial: output });
	call.arguments = { command: "echo native" };
	stream.push({ type: "toolcall_delta", contentIndex: 3, delta: nativeArguments, partial: output });
	pushAssistantProgress(stream, {
		type: "message_tool_arguments_reset",
		contentIndex: 3,
		rawArgumentPrefix: nativeArguments,
		parsedThrough: nativeArguments.length,
	});
	stream.push({ type: "toolcall_end", contentIndex: 3, toolCall: call, partial: output });
	output.stopReason = "toolUse";
	stream.push({ type: "done", reason: "toolUse", message: output });
	stream.end(output);
	return stream;
}

describe("invoke recovery capture remap #4272", () => {
	it("keeps the public bytes recorded before capture", async () => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(true), [tool]));
		expect(publicBytes(publicEvents(records))).toMatchSnapshot();
	});

	it("remaps the kept records to outer indices and drops the ones the projection does not follow", async () => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(true), [tool]));
		expect(recordKinds(records)).toEqual([
			"start",
			"thinking_start:0",
			"thinking_delta:0",
			"message_block_metadata:0",
			"thinking_end:0",
			"text_start:1",
			"text_delta:1",
			"toolcall_start:2",
			"toolcall_delta:2",
			"toolcall_end:2",
			"text_delta:3",
			"text_end:3",
			"message_block_state:4:insert",
			"message_block_state:4:end",
			"toolcall_start:5",
			"toolcall_delta:5",
			"message_tool_arguments_reset:5",
			"toolcall_end:5",
			"done",
		]);
		expect(progressRecords(records)).toEqual([
			{ type: "message_block_metadata", contentIndex: 0, thinkingSignatureDelta: "sig" },
			{ type: "message_block_state", contentIndex: 4, phase: "insert", block: searchInProgress },
			{ type: "message_block_state", contentIndex: 4, phase: "end", block: completedSearch },
			{
				type: "message_tool_arguments_reset",
				contentIndex: 5,
				rawArgumentPrefix: nativeArguments,
				parsedThrough: nativeArguments.length,
			},
		]);
		const events = publicEvents(records);
		const done = firstEvent(events, "done");
		expect(recordsOnForeignBlocks(records, done.message)).toEqual([]);
		expect(events.filter((event) => getAssistantCapture(event) === undefined).map((event) => event.type)).toEqual([]);
		expect(getAssistantCapture(done)?.message?.content.map((block) => block.type)).toEqual(
			done.message.content.map((block) => block.type),
		);
	});

	it("carries the source's emission-time seed for a lagging 1:1 copy instead of capturing the copy", async () => {
		const events = publicEvents(await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(true), [tool])));
		const thinkingStart = firstEvent(events, "thinking_start", 0);
		expect(thinkingStart.partial.content[0]).toMatchObject({ thinking: "plan" });
		expect(getAssistantCapture(thinkingStart)).toMatchObject({
			block: { type: "thinking", thinking: "" },
			coveredCodeUnits: 0,
		});
		expect(deltaCaptures(events, "thinking_delta")).toEqual([{ delta: "plan", offset: 0, parsedThrough: undefined }]);
		expect(getAssistantCapture(firstEvent(events, "thinking_end", 0))?.block).toEqual({
			type: "thinking",
			thinking: "plan",
			thinkingSignature: "sig",
		});
		const nativeStart = firstEvent(events, "toolcall_start", 5);
		expect(nativeStart.partial.content[5]).toMatchObject({ arguments: { command: "echo native" } });
		expect(getAssistantCapture(nativeStart)).toMatchObject({
			block: { type: "toolCall", id: "native", arguments: {} },
			rawArgumentPrefix: "",
			parsedThrough: 0,
			coveredCodeUnits: 0,
		});
		const toolDeltas = deltaCaptures(events, "toolcall_delta");
		expect(toolDeltas[1]).toEqual({ delta: nativeArguments, offset: 0, parsedThrough: nativeArguments.length });
	});

	it("captures the blocks the projection builds itself at their outer indices", async () => {
		const events = publicEvents(await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(true), [tool])));
		expect(getAssistantCapture(firstEvent(events, "text_start", 1))?.block).toMatchObject({ type: "text", text: "" });
		expect(deltaCaptures(events, "text_delta")).toEqual([
			{ delta: "before ", offset: 0, parsedThrough: undefined },
			{ delta: " after", offset: 0, parsedThrough: undefined },
		]);
		expect(getAssistantCapture(firstEvent(events, "toolcall_start", 2))).toMatchObject({
			block: { type: "toolCall", id: "recovered-antml-0", arguments: {} },
			rawArgumentPrefix: "",
		});
		const recoveredDelta = deltaCaptures(events, "toolcall_delta")[0];
		expect(recoveredDelta).toMatchObject({ offset: 0 });
		expect(JSON.parse(recoveredDelta?.delta ?? "")).toEqual({ command: "echo recovered" });
		expect(getAssistantCapture(firstEvent(events, "toolcall_end", 2))?.block).toMatchObject({
			arguments: { command: "echo recovered" },
		});
	});

	it("never captures a lagging copy whose source carried no record", async () => {
		const records = await drainRecords(wrapStreamWithInvokeRecovery(bufferedProviderTurn(false), [tool]));
		const captured = publicEvents(records).map((event) =>
			"contentIndex" in event
				? `${event.type}:${event.contentIndex}:${getAssistantCapture(event) !== undefined}`
				: `${event.type}:${getAssistantCapture(event) !== undefined}`,
		);
		expect(captured).toEqual([
			"start:true",
			"thinking_start:0:false",
			"thinking_delta:0:false",
			"thinking_end:0:false",
			"text_start:1:true",
			"text_delta:1:true",
			"toolcall_start:2:true",
			"toolcall_delta:2:true",
			"toolcall_end:2:true",
			"text_delta:3:true",
			"text_end:3:true",
			"toolcall_start:5:false",
			"toolcall_delta:5:false",
			"toolcall_end:5:false",
			"done:true",
		]);
		expect(progressRecords(records)).toEqual([]);
	});
});
