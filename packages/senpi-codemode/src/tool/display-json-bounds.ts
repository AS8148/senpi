import {
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
} from "./json-tree.ts";

/** Model-facing display text budget; the stored jsonOutputs entry follows the same order of budget. */
export const MAX_DISPLAY_TEXT_BYTES = 8_000;
export const MAX_DISPLAY_JSON_BYTES = MAX_DISPLAY_TEXT_BYTES;

const ELISION_MARKER = "…";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Byte length of a `{type:"Buffer",data:[...]}` serialization, or undefined when the shape is not one. */
export function serializedBufferByteLength(value: unknown): number | undefined {
	if (!isRecord(value) || value.type !== "Buffer" || !Array.isArray(value.data)) return undefined;
	for (const byte of value.data) {
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

type Budget = { remaining: number };

function boundString(value: string, budget: Budget): string {
	if (value.length <= JSON_TREE_SCALAR_LEN_EXPANDED) {
		budget.remaining -= value.length;
		return value;
	}
	const kept = `${value.slice(0, JSON_TREE_SCALAR_LEN_EXPANDED)}[…${value.length - JSON_TREE_SCALAR_LEN_EXPANDED}ch elided…]`;
	budget.remaining -= kept.length;
	return kept;
}

function boundArray(value: readonly unknown[], depth: number, budget: Budget): unknown[] {
	const kept: unknown[] = [];
	for (const [index, item] of value.entries()) {
		if (index >= JSON_TREE_MAX_LINES_EXPANDED || budget.remaining <= 0) {
			kept.push(`… (${value.length - index} more items)`);
			return kept;
		}
		kept.push(boundNode(item, depth + 1, budget));
	}
	return kept;
}

function boundRecord(value: Record<string, unknown>, depth: number, budget: Budget): Record<string, unknown> {
	const kept: Record<string, unknown> = {};
	const keys = Object.keys(value);
	for (const [index, key] of keys.entries()) {
		if (index >= JSON_TREE_MAX_LINES_EXPANDED || budget.remaining <= 0) {
			kept[ELISION_MARKER] = `${keys.length - index} more keys`;
			return kept;
		}
		budget.remaining -= key.length;
		kept[key] = boundNode(value[key], depth + 1, budget);
	}
	return kept;
}

function boundNode(value: unknown, depth: number, budget: Budget): unknown {
	if (budget.remaining <= 0) return ELISION_MARKER;
	if (value === null || value === undefined) return value;
	if (typeof value === "boolean") {
		budget.remaining -= 5;
		return value;
	}
	if (typeof value === "number") {
		budget.remaining -= 8;
		return value;
	}
	if (typeof value === "string") return boundString(value, budget);
	const bufferBytes = serializedBufferByteLength(value);
	if (bufferBytes !== undefined) {
		const placeholder = bufferPlaceholder(bufferBytes);
		budget.remaining -= placeholder.length;
		return placeholder;
	}
	if (depth >= JSON_TREE_MAX_DEPTH_EXPANDED) return ELISION_MARKER;
	if (Array.isArray(value)) return boundArray(value, depth, budget);
	if (isRecord(value)) return boundRecord(value, depth, budget);
	return String(value);
}

/**
 * Bounds one display value for persistence in `details.jsonOutputs`: serialized Buffers collapse to a
 * placeholder, scalars/arrays/keys/depth follow the JSON-tree render budgets, and the serialized entry
 * never exceeds MAX_DISPLAY_JSON_BYTES.
 */
export function sanitizeDisplayJson(value: unknown): unknown {
	const sanitized = boundNode(value, 0, { remaining: MAX_DISPLAY_JSON_BYTES });
	const serialized = JSON.stringify(sanitized);
	if (serialized === undefined || serialized.length <= MAX_DISPLAY_JSON_BYTES) return sanitized;
	return `[display value elided: entry exceeds the ${MAX_DISPLAY_JSON_BYTES}-byte storage budget]`;
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
