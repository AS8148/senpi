import type { AssistantMessage, AssistantMessageEvent, Usage } from "../types.ts";

type PublicBlock = AssistantMessage["content"][number];
export type AssistantProgress =
	| { type: "message_block_state"; contentIndex: number; phase: "insert" | "end"; block: PublicBlock }
	| {
			type: "message_block_metadata";
			contentIndex: number;
			/** Appends to the signature; `thinkingSignature` and `textSignature` replace it. */
			thinkingSignatureDelta?: string;
			thinkingSignature?: string;
			textSignature?: string;
			redacted?: true;
			name?: string;
			startedAt?: number;
			endedAt?: number;
	  }
	| {
			type: "message_tool_arguments_reset";
			contentIndex: number;
			rawArgumentPrefix: string;
			parsedThrough: number;
	  };
export type AssistantRecord = AssistantMessageEvent | AssistantProgress;
/** One entry of a stream's single ordered queue. */
export type OrderedEntry = { event: AssistantMessageEvent } | { progress: AssistantProgress };
type QueueReader = <V>(project: (entry: OrderedEntry) => IteratorResult<V> | undefined) => AsyncIterator<V>;
export interface AssistantCapture {
	readonly usage: Usage;
	readonly metadata?: Partial<{
		[K in keyof Omit<AssistantMessage, "content" | "usage">]: AssistantMessage[K] | null;
	}>;
	readonly block?: PublicBlock;
	readonly message?: AssistantMessage;
	readonly rawArgumentPrefix?: string;
	readonly coveredCodeUnits?: number;
	readonly offset?: number;
	readonly parsedThrough?: number;
}

const captures = new WeakMap<object, AssistantCapture>();
const readers = new WeakMap<object, QueueReader>();
const writers = new WeakMap<object, (progress: AssistantProgress) => void>();
const states = new WeakMap<object, { positions: Map<number, CapturePosition>; metadata: Map<string, unknown> }>();

export function setAssistantReader(owner: object, reader: QueueReader): void {
	readers.set(owner, reader);
}

export function setAssistantProgressWriter(owner: object, writer: (progress: AssistantProgress) => void): void {
	writers.set(owner, writer);
}

export function enableAssistantCapture(owner: object): void {
	if (!states.has(owner)) states.set(owner, { positions: new Map(), metadata: new Map() });
}

export function pushAssistantProgress(owner: object, progress: AssistantProgress): void {
	const writer = writers.get(owner);
	if (!writer) return;
	if (progress.type === "message_tool_arguments_reset")
		states.get(owner)?.positions.set(progress.contentIndex, {
			offset: progress.rawArgumentPrefix.length,
			parsedThrough: progress.parsedThrough,
		});
	// A forwarded record is already a frozen public copy; copying it again would only double large native payloads.
	writer(
		Object.isFrozen(progress)
			? progress
			: freezeCapture(
					progress.type === "message_block_state" ? { ...progress, block: publicBlock(progress.block) } : progress,
				),
	);
}

/** A text or thinking signature replaced without a public event; an unchanged or empty one records nothing. */
export function pushAssistantSignature(
	owner: object,
	contentIndex: number,
	block: Extract<PublicBlock, { type: "text" | "thinking" }>,
	signature: string | undefined,
): void {
	if (!signature || signature === (block.type === "text" ? block.textSignature : block.thinkingSignature)) return;
	pushAssistantProgress(owner, {
		type: "message_block_metadata",
		contentIndex,
		...(block.type === "text" ? { textSignature: signature } : { thinkingSignature: signature }),
	});
}

/** A block appended complete with no public event: its insert and end share one frozen copy. */
export function pushAssistantCompleteBlock(owner: object, contentIndex: number, block: PublicBlock): void {
	const frozen = freezeCapture(publicBlock(block));
	for (const phase of ["insert", "end"] as const)
		pushAssistantProgress(owner, Object.freeze({ type: "message_block_state", contentIndex, phase, block: frozen }));
}

/** Internal consumption is explicit; ordinary iterators are the downgrade boundary. */
export function assistantRecords(source: AsyncIterable<AssistantMessageEvent>): AsyncIterable<AssistantRecord> {
	const read = readers.get(source);
	return {
		[Symbol.asyncIterator]: () =>
			read?.<AssistantRecord>((entry) => ({
				value: "event" in entry ? entry.event : entry.progress,
				done: false,
			})) ?? source[Symbol.asyncIterator](),
	};
}

/** Events only; each progress record goes to `onProgress` as it is read, so a forwarder spends no turn on it. */
export function assistantEvents(
	source: AsyncIterable<AssistantMessageEvent>,
	onProgress: (progress: AssistantProgress) => void,
): AsyncIterable<AssistantMessageEvent> {
	const read = readers.get(source);
	return {
		[Symbol.asyncIterator]: () =>
			read?.<AssistantMessageEvent>((entry) => {
				if ("event" in entry) return { value: entry.event, done: false };
				onProgress(entry.progress);
				return undefined;
			}) ?? source[Symbol.asyncIterator](),
	};
}

export function getAssistantCapture(event: object): AssistantCapture | undefined {
	return captures.get(event);
}

export function isAssistantProgress(event: AssistantRecord): event is AssistantProgress {
	return (
		event.type === "message_block_state" ||
		event.type === "message_block_metadata" ||
		event.type === "message_tool_arguments_reset"
	);
}

export interface CaptureHint {
	readonly rawArgumentPrefix?: string;
	readonly parsedThrough?: number;
	/** Replay deltas may begin before the bytes already covered by a deferred start. */
	readonly offset?: number;
}
export interface CapturePosition {
	offset: number;
	parsedThrough: number;
}

export function freezeCapture<T>(value: T): T {
	const freeze = (part: unknown): void => {
		if (part === null || typeof part !== "object" || Object.isFrozen(part)) return;
		for (const child of Object.values(part)) freeze(child);
		Object.freeze(part);
	};
	const copy = structuredClone(value);
	freeze(copy);
	return copy;
}

/** Only declared public fields survive; provider scratch and symbols never enter a seed. */
export function publicBlock(block: PublicBlock): PublicBlock {
	const fields = {
		text: ["type", "text", "audience", "textSignature"],
		thinking: ["type", "thinking", "thinkingSignature", "redacted", "startedAt", "endedAt"],
		toolCall: ["type", "id", "name", "arguments", "incomplete", "errorMessage", "thoughtSignature", "namespace"],
		providerNative: ["type", "subtype", "raw"],
	};
	return Object.fromEntries(
		fields[block.type].filter((key) => key in block).map((key) => [key, Reflect.get(block, key)]),
	) as PublicBlock;
}

export function dropAssistantCapture(event: object): void {
	captures.delete(event);
}

export function carryAssistantCapture<T extends object>(source: object, target: T, terminal?: AssistantMessage): T {
	const capture = captures.get(source);
	if (capture)
		captures.set(
			target,
			terminal
				? Object.freeze({
						...capture,
						message: freezeCapture({ ...terminal, content: terminal.content.map(publicBlock) }),
					})
				: capture,
		);
	return target;
}

/** Never parses or traverses a block on a delta, including a no-growth delta. */
export function captureAssistantEvent(owner: object, event: AssistantMessageEvent, hint: CaptureHint = {}): void {
	const state = states.get(owner);
	if (!state || captures.has(event)) return;
	const { positions, metadata: previousMetadata } = state;
	const message = event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial;
	const usage = freezeCapture(message.usage);
	const changed: Record<string, unknown> = {};
	for (const key of Object.keys(message)) {
		if (key === "content" || key === "usage") continue;
		const value: unknown = Reflect.get(message, key);
		if (!previousMetadata.has(key) || previousMetadata.get(key) !== value) changed[key] = value;
		previousMetadata.set(key, value);
	}
	for (const key of previousMetadata.keys()) {
		if (!(key in message)) {
			changed[key] = null;
			previousMetadata.delete(key);
		}
	}
	const metadata = freezeCapture(changed);
	if (!("contentIndex" in event)) {
		captures.set(
			event,
			Object.freeze({
				usage,
				metadata,
				message: freezeCapture({ ...message, content: message.content.map(publicBlock) }),
			}),
		);
		return;
	}
	const index = event.contentIndex;
	if ("delta" in event) {
		const position = positions.get(index) ?? { offset: 0, parsedThrough: 0 };
		const offset = hint.offset ?? position.offset;
		position.offset = offset + event.delta.length;
		if (event.type === "toolcall_delta" && event.delta.length > 0) {
			position.parsedThrough = hint.parsedThrough ?? Math.max(position.parsedThrough, position.offset);
		}
		positions.set(index, position);
		captures.set(
			event,
			Object.freeze({
				usage,
				metadata,
				offset,
				...(event.type === "toolcall_delta" ? { parsedThrough: position.parsedThrough } : {}),
			}),
		);
		return;
	}
	const block = publicBlock(event.type === "toolcall_end" ? event.toolCall : message.content[index]);
	if (event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start") {
		const rawArgumentPrefix = hint.rawArgumentPrefix ?? "";
		const coveredCodeUnits =
			block.type === "text"
				? block.text.length
				: block.type === "thinking"
					? block.thinking.length
					: rawArgumentPrefix.length;
		const parsedThrough = hint.parsedThrough ?? 0;
		positions.set(index, { offset: hint.offset ?? coveredCodeUnits, parsedThrough });
		captures.set(
			event,
			freezeCapture({
				usage,
				metadata,
				block,
				coveredCodeUnits,
				...(block.type === "toolCall" ? { rawArgumentPrefix, parsedThrough } : {}),
			}),
		);
	} else {
		captures.set(event, freezeCapture({ usage, metadata, block }));
	}
}
