import { afterEach, beforeEach } from "vitest";
import type { AssistantMessageEvent } from "../src/types.ts";
import {
	type AssistantProgress,
	type AssistantRecord,
	assistantRecords,
	getAssistantCapture,
	isAssistantProgress,
	subscribeAssistantCapture,
} from "../src/utils/assistant-capture.ts";
import type { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

/** Holds a capture subscription around each test of the calling file, as an internal agent listener does. */
export function subscribeCaptureForEachTest(): void {
	let release = () => {};
	beforeEach(() => {
		release = subscribeAssistantCapture();
	});
	afterEach(() => release());
}

/** Settles first: every start and delta is emitted before the reader resumes, so late seeds would hold later bytes. */
export async function drainRecords(stream: AssistantMessageEventStream): Promise<AssistantRecord[]> {
	await stream.result();
	const records: AssistantRecord[] = [];
	for await (const record of assistantRecords(stream)) records.push(record);
	return records;
}

export function publicEvents(records: AssistantRecord[]): AssistantMessageEvent[] {
	return records.flatMap((record) => (isAssistantProgress(record) ? [] : [record]));
}

export function progressRecords(records: AssistantRecord[]): AssistantProgress[] {
	return records.filter(isAssistantProgress);
}

export function recordKinds(records: AssistantRecord[]): string[] {
	return records.map((record) => {
		if (record.type === "message_block_state") return `${record.type}:${record.contentIndex}:${record.phase}`;
		return "contentIndex" in record ? `${record.type}:${record.contentIndex}` : record.type;
	});
}

export function publicBytes(events: AssistantMessageEvent[]): string {
	return JSON.stringify(events).replace(/"timestamp":\d+/g, '"timestamp":0');
}

export function deltaCaptures(
	events: AssistantMessageEvent[],
	type: "text_delta" | "thinking_delta" | "toolcall_delta",
): { delta: string; offset: number | undefined; parsedThrough: number | undefined }[] {
	return events.flatMap((event) => {
		if (event.type !== type || !("delta" in event)) return [];
		const capture = getAssistantCapture(event);
		return [{ delta: event.delta, offset: capture?.offset, parsedThrough: capture?.parsedThrough }];
	});
}

export function firstEvent<T extends AssistantMessageEvent["type"]>(
	events: AssistantMessageEvent[],
	type: T,
	contentIndex?: number,
): Extract<AssistantMessageEvent, { type: T }> {
	const found = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: T }> =>
			event.type === type &&
			(contentIndex === undefined || ("contentIndex" in event && event.contentIndex === contentIndex)),
	);
	if (!found) throw new Error(`no ${type} event${contentIndex === undefined ? "" : ` at ${contentIndex}`}`);
	return found;
}

export function mintedIdentityKeys(message: object | undefined): string[] {
	return ["messageId", "turnId", "runtimeItemKey"].filter((key) => message !== undefined && key in message);
}
