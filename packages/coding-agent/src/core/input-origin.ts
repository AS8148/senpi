import type { InputSource } from "./extensions/types.ts";

/**
 * Who an input came from, classified at its entry point: a TUI submit or an RPC client prompt/steer/follow_up/answer
 * is a `person`; an extension API send is `extension`; goal, monitor, codemode and other automation is `engine`.
 */
export type InputOrigin = "person" | "extension" | "engine";

/** The origin of an input from its entry-point source: only an extension API send is not a person's. */
export function inputOriginOf(source: InputSource | undefined): InputOrigin {
	return source === "extension" ? "extension" : "person";
}
