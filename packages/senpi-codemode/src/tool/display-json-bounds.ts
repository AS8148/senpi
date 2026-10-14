import {
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree.ts";

/** Model-facing display text budget; the stored jsonOutputs entry follows the same order of budget. */
export const MAX_DISPLAY_TEXT_BYTES = 8_000;
/**
 * Total serialized-size budget for one stored entry. Measured in characters (JS string length), so
 * non-ASCII text can store up to ~3x this many UTF-8 bytes; the bound is what matters (#3261 review).
 */
export const MAX_DISPLAY_JSON_BYTES = MAX_DISPLAY_TEXT_BYTES;

// Serialized-size headroom for JSON punctuation beyond per-node accounting (commas, colons, braces).
const PUNCTUATION_ALLOWANCE = 512;

type Budget = { remaining: number };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Length of value's JSON string body after escaping; bounded at 6x plus quotes, never serialized here. */
function serializedStringLength(value: string): number {
	let length = 2;
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		// Control characters, quotes and backslashes escape (up to \uXXXX); everything else is one char.
		length += codePoint < 0x20 || character === '"' || character === "\\" ? JSON.stringify(character).length : 1;
	}
	return length;
}

/**
 * Byte length of a `{type:"Buffer",data:[...]}` serialization, or undefined when the shape is not one.
 * Only a bounded prefix of the data array is validated, so a multi-MB legacy dump never gets walked (#3261).
 */
export function serializedBufferByteLength(value: unknown): number | undefined {
	if (!isRecord(value) || value.type !== "Buffer" || !Array.isArray(value.data)) return undefined;
	if (value.data.length === 0) return 0;
	const prefixLength = Math.min(value.data.length, 1_024);
	for (let index = 0; index < prefixLength; index += 1) {
		const byte = value.data[index];
		if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return undefined;
	}
	return value.data.length;
}

export function formatByteLength(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
	return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

export function bufferPlaceholder(bytes: number): string {
	return `<Buffer ${formatByteLength(bytes)}>`;
}

function boundString(value: string, budget: Budget): string {
	const serialized = serializedStringLength(value);
	if (serialized <= budget.remaining && value.length <= JSON_TREE_SCALAR_LEN_EXPANDED) {
		budget.remaining -= serialized;
		return value;
	}
	// Long or escaped strings keep a prefix; the marker stays visible in the stored entry.
	const serializedBudget = Math.max(0, budget.remaining - 40);
	let keptLength = Math.min(JSON_TREE_SCALAR_LEN_EXPANDED, value.length);
	while (keptLength > 0 && serializedStringLength(value.slice(0, keptLength)) > serializedBudget) {
		keptLength = Math.floor(keptLength / 2);
	}
	const kept = value.slice(0, keptLength);
	const marked = `${kept}[…${value.length - kept.length}ch elided…]`;
	budget.remaining -= serializedStringLength(marked);
	return marked;
}

function boundArray(value: readonly unknown[], depth: number, budget: Budget): unknown[] {
	const kept: unknown[] = [];
	budget.remaining -= 2; // []
	for (const [index, item] of value.entries()) {
		if (index >= JSON_TREE_MAX_LINES_EXPANDED || budget.remaining <= 0) {
			kept.push(`… (${value.length - index} more items)`);
			return kept;
		}
		if (index > 0) budget.remaining -= 1; // comma
		kept.push(boundNode(item, depth + 1, budget));
	}
	return kept;
}

function boundRecord(value: Record<string, unknown>, depth: number, budget: Budget): Record<string, unknown> {
	const kept: Record<string, unknown> = {};
	budget.remaining -= 2; // {}
	const keys = Object.keys(value);
	for (const [index, key] of keys.entries()) {
		if (index >= JSON_TREE_MAX_LINES_EXPANDED) {
			kept["…"] = `${keys.length - index} more keys`;
			return kept;
		}
		if (index > 0) budget.remaining -= 1; // comma
		budget.remaining -= key.length + 3; // "key":
		const childBudget: Budget = { remaining: budget.remaining };
		const child = boundNode(value[key], depth + 1, childBudget);
		// When the next value cannot fit even trimmed, stop and mark the rest instead of starving it.
		if (childBudget.remaining <= 0 && typeof value[key] === "string" && String(child).endsWith("0ch elided…]")) {
			kept["…"] = `${keys.length - index} more keys`;
			return kept;
		}
		budget.remaining = childBudget.remaining;
		kept[key] = child;
		if (budget.remaining <= 0 && index < keys.length - 1) {
			kept["…"] = `${keys.length - index - 1} more keys`;
			return kept;
		}
	}
	return kept;
}

function boundNode(value: unknown, depth: number, budget: Budget): unknown {
	if (budget.remaining <= 0) return "…";
	if (value === null || value === undefined) {
		budget.remaining -= 4;
		return value;
	}
	if (typeof value === "boolean") {
		budget.remaining -= 5;
		return value;
	}
	if (typeof value === "number") {
		budget.remaining -= 24;
		return value;
	}
	if (typeof value === "string") return boundString(value, budget);
	const bufferBytes = serializedBufferByteLength(value);
	if (bufferBytes !== undefined) {
		const placeholder = bufferPlaceholder(bufferBytes);
		budget.remaining -= serializedStringLength(placeholder);
		return placeholder;
	}
	if (depth >= JSON_TREE_MAX_DEPTH_EXPANDED) {
		budget.remaining -= 3;
		return "…";
	}
	if (Array.isArray(value)) return boundArray(value, depth, budget);
	if (isRecord(value)) return boundRecord(value, depth, budget);
	return String(value);
}

/**
 * Estimates the serialized length of a bounded value without building it, so the stored entry can be
 * re-trimmed (never dropped) when the first pass overshoots.
 */
function estimateSerializedLength(value: unknown): number {
	if (value === null || value === undefined) return 4;
	if (typeof value === "boolean") return value ? 4 : 5;
	if (typeof value === "number") return 24;
	if (typeof value === "string") return serializedStringLength(value);
	if (Array.isArray(value)) {
		let length = 2;
		for (const [index, item] of value.entries()) {
			if (index > 0) length += 1;
			length += estimateSerializedLength(item);
		}
		return length;
	}
	if (isRecord(value)) {
		let length = 2;
		let index = 0;
		for (const key in value) {
			if (index > 0) length += 1;
			length += key.length + 3 + estimateSerializedLength(value[key]);
			index += 1;
		}
		return length;
	}
	return 16;
}

/**
 * Bounds one display value for persistence in `details.jsonOutputs`. The whole value is always kept:
 * serialized Buffers collapse to a `<Buffer N>` placeholder, strings/arrays/objects trim to a visible
 * `… elided` / `N more items` / `N more keys` marker, and depth follows the JSON-tree caps. When the
 * first pass still overshoots the budget (punctuation beyond the allowance), it re-trims with a tighter
 * budget instead of dropping the value (#3261 review).
 */
export function sanitizeDisplayJson(value: unknown): unknown {
	let budget = MAX_DISPLAY_JSON_BYTES - PUNCTUATION_ALLOWANCE;
	let sanitized = boundNode(value, 0, { remaining: budget });
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const estimated = estimateSerializedLength(sanitized);
		if (estimated <= MAX_DISPLAY_JSON_BYTES) return sanitized;
		budget = Math.max(256, Math.floor(budget / 2));
		sanitized = boundNode(value, 0, { remaining: budget });
	}
	return sanitized;
}

/**
 * Iterative early-exit size estimate for stored entries (legacy sessions carry multi-MB ones); never
 * enumerates more of the value than the budget plus a key.
 */
export function displayJsonSizeExceeds(value: unknown, budget: number): boolean {
	let size = 0;
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const node = pending.pop();
		if (node === null || node === undefined) continue;
		if (typeof node === "boolean" || typeof node === "number") {
			size += 8;
		} else if (typeof node === "string") {
			size += node.length;
		} else if (Array.isArray(node)) {
			size += 2;
			for (const child of node) {
				size += 1;
				if (size > budget) return true;
				pending.push(child);
			}
		} else if (isRecord(node)) {
			size += 2;
			for (const key in node) {
				size += key.length + 1;
				if (size > budget) return true;
				pending.push(node[key]);
			}
		}
		if (size > budget) return true;
	}
	return false;
}
