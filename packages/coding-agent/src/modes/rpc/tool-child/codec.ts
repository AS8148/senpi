import type { ToolChildMessage } from "./protocol.ts";
export type ToolChildCodecErrorCode = "tool_child_frame_too_large" | "tool_child_truncated" | "tool_child_malformed";
export class ToolChildCodecError extends Error {
	readonly code: ToolChildCodecErrorCode;
	constructor(code: ToolChildCodecErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
export const FRAME_HEADER_BYTES = 4;
export function encodeFrame(_message: ToolChildMessage): Uint8Array {
	throw new Error("not implemented");
}
export class FrameDecoder {
	get bufferedBytes(): number {
		throw new Error("not implemented");
	}
	push(_chunk: Uint8Array): ToolChildMessage[] {
		throw new Error("not implemented");
	}
	end(): void {
		throw new Error("not implemented");
	}
}
