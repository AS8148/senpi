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

/** A redacted JSON copy for persistence or display; the wire-facing original keeps its exact strings. */
export function redactResolvedReferenceData<T>(value: T): T {
	const json = resolvedValues.size === 0 ? undefined : JSON.stringify(value);
	return json === undefined ? value : JSON.parse(redactResolvedReferenceValues(json));
}
