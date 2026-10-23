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

/** MCP content-block and resource kinds plus JSON Schema types. */
const PROTOCOL_TYPES = new Set([
	"text",
	"image",
	"audio",
	"resource",
	"resource_link",
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);
/** JSON Schema string formats. */
const SCHEMA_FORMATS = new Set([
	"date-time",
	"date",
	"time",
	"duration",
	"email",
	"idn-email",
	"hostname",
	"idn-hostname",
	"ipv4",
	"ipv6",
	"uri",
	"uri-reference",
	"iri",
	"iri-reference",
	"uri-template",
	"uuid",
	"json-pointer",
	"relative-json-pointer",
	"regex",
	"byte",
	"binary",
	"password",
]);

/**
 * A string under one of these keys is kept only when it is a known protocol value (a content-block kind, a
 * schema type or format, a media type, the JSON-RPC version, a role); any other value is redacted as usual,
 * so a credential echoed into a protocol field is still caught (fail closed).
 */
const PROTOCOL_VALUES: Readonly<Record<string, (value: string) => boolean>> = {
	type: (value) => PROTOCOL_TYPES.has(value),
	mimeType: (value) => value.length <= 100 && /^[a-z]+\/[\w.+-]+$/i.test(value),
	format: (value) => SCHEMA_FORMATS.has(value),
	jsonrpc: (value) => value === "2.0",
	role: (value) => value === "user" || value === "assistant",
	$schema: (value) => value.length <= 100 && /^https:\/\/json-schema\.org\/[\w./-]+$/.test(value),
};

function isProtocolValue(key: string, value: string): boolean {
	return Object.hasOwn(PROTOCOL_VALUES, key) && PROTOCOL_VALUES[key]?.(value) === true;
}

/** Copies JSON-shaped data, redacting string leaves only; never mutates the wire-facing original. */
export function redactResolvedReferenceData<T>(value: T): T;
export function redactResolvedReferenceData(value: unknown): unknown {
	if (resolvedValues.size === 0) return value;
	const copies = new WeakMap<object, object>();
	const pending: { source: object; target: object }[] = [];
	const copy = (input: unknown): unknown => {
		// Serialize like JSON would, so a Date reaches the sink as its ISO string rather than an empty object.
		const source =
			typeof input === "object" && input !== null && typeof Reflect.get(input, "toJSON") === "function"
				? (Reflect.get(input, "toJSON") as () => unknown).call(input)
				: input;
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
			const child = Reflect.get(source, key);
			Object.defineProperty(target, key, {
				value: typeof child === "string" && isProtocolValue(key, child) ? child : copy(child),
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
	}
	return result;
}
