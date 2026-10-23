const MIN_REDACTED_LENGTH = 4;
const resolvedValues = new Set<string>();
let redactionForms: readonly string[] | undefined;

/** Every value a reference resolves to is kept for the process lifetime, including rotated ones: no cap, no eviction. */
export function rememberResolvedReferenceValue(value: string): void {
	if (value.length < MIN_REDACTED_LENGTH || resolvedValues.has(value)) return;
	resolvedValues.add(value);
	redactionForms = undefined;
}

function encodings(value: string): string[] {
	const form = new URLSearchParams([["", value]]).toString().slice(1);
	return [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), encodeURI(value), form];
}

function forms(): readonly string[] {
	redactionForms ??= [...new Set([...resolvedValues].flatMap(encodings))]
		.filter((form) => form.length >= MIN_REDACTED_LENGTH)
		.sort((left, right) => right.length - left.length);
	return redactionForms;
}

/** Replaces every resolved reference value, raw or encoded, before text reaches a sink outside the process. */
export function redactResolvedReferenceValues(text: string, replacement = "<redacted>"): string {
	let redacted = text;
	for (const form of forms()) {
		if (redacted.includes(form)) redacted = redacted.split(form).join(replacement);
	}
	return redacted;
}

/** Copies JSON-shaped data, redacting string leaves only; never mutates the wire-facing original. */
export function redactResolvedReferenceData<T>(value: T): T;
export function redactResolvedReferenceData(value: unknown): unknown {
	if (resolvedValues.size === 0) return value;
	const copies = new WeakMap<object, object>();
	const pending: { source: object; target: object }[] = [];
	const copy = (source: unknown): unknown => {
		if (typeof source === "string") return redactResolvedReferenceValues(source);
		if (typeof source !== "object" || source === null) return source;
		const existing = copies.get(source);
		if (existing !== undefined) return existing;
		const target: object = Array.isArray(source) ? new Array(source.length) : {};
		copies.set(source, target);
		pending.push({ source, target });
		return target;
	};
	const result = copy(value);
	// A worklist and memoized copies handle arbitrary depth, cycles and shared children.
	for (const { source, target } of pending) {
		for (const key of Object.keys(source)) {
			Object.defineProperty(target, key, {
				value: copy(Reflect.get(source, key)),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return result;
}
