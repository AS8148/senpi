import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

const FileReferenceSchema = Type.Object({ $file: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const EnvReferenceSchema = Type.Object(
	{ $env: Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }) },
	{ additionalProperties: false },
);
const ConcatReferenceSchema = Type.Object(
	{ $concat: Type.Array(Type.Union([Type.String(), FileReferenceSchema, EnvReferenceSchema])) },
	{ additionalProperties: false },
);

export const ConfigReferenceSchema = Type.Union([FileReferenceSchema, EnvReferenceSchema, ConcatReferenceSchema]);
export const ConfigValueSchema = Type.Union([Type.String(), ConfigReferenceSchema]);
export const NonemptyConfigValueSchema = Type.Union([Type.String({ minLength: 1 }), ConfigReferenceSchema]);
export type ConfigReference = Static<typeof ConfigReferenceSchema>;
export type ConfigValue = string | ConfigReference;

export type ConfigReferenceReason =
	| "malformed"
	| "forbidden"
	| "unset"
	| "empty"
	| "missing"
	| "unreadable"
	| "oversize"
	| "invalid-utf8"
	| "non-regular"
	| "unsafe-owner"
	| "unsafe-permissions"
	| "changed";

/** Contains the declaration, never resolved credential bytes. */
export class ConfigReferenceError extends Error {
	readonly field: string;
	readonly reference: unknown;
	readonly reason: ConfigReferenceReason;

	constructor(field: string, reference: unknown, reason: ConfigReferenceReason) {
		super(`${field}: configuration reference ${reason}`);
		this.name = "ConfigReferenceError";
		this.field = field;
		this.reference = reference;
		this.reason = reason;
	}
}

const validateReference = Compile(ConfigReferenceSchema);

export function isConfigReference(value: unknown): value is ConfigReference {
	return validateReference.Check(value);
}

/** Used only at declared string-value boundaries, never on opaque JSON fields. */
export function assertConfigValue(value: unknown, field: string): asserts value is ConfigValue {
	if (typeof value !== "string" && !isConfigReference(value)) {
		throw new ConfigReferenceError(field, value, "malformed");
	}
}
