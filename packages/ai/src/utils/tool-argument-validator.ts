import type { TSchema } from "typebox";

const validators = new WeakMap<TSchema, (value: unknown) => boolean>();

/** A protocol may own validation without permitting local argument coercion. */
export function registerToolArgumentValidator(schema: TSchema, validate: (value: unknown) => boolean): void {
	validators.set(schema, validate);
}

export function getToolArgumentValidator(schema: TSchema): ((value: unknown) => boolean) | undefined {
	return validators.get(schema);
}
