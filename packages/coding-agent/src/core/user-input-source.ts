import type { InputSource } from "./extensions/types.ts";

/**
 * Persisted provenance of a user message: the same `source` its `input` event reported. A message
 * restored from durable custody or moved from another session ran no `input` event, so it carries none.
 */
export type UserInputSource = { readonly inputSource?: InputSource };

export function userInputSource(source: InputSource | undefined): UserInputSource {
	return source === undefined ? {} : { inputSource: source };
}
