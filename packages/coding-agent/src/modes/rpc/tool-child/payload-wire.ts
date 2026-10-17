import type { PayloadRefReader, PayloadRefWriter } from "./payload-ref.ts";
import type { PayloadRef } from "./protocol.ts";
export type PackedPayload = { inline: true; value: unknown } | { inline: false; ref: PayloadRef };
export async function packPayload(_value: unknown, _writer: PayloadRefWriter): Promise<PackedPayload> {
	throw new Error("not implemented");
}
export async function unpackPayload(_ref: PayloadRef, _reader: PayloadRefReader): Promise<unknown> {
	throw new Error("not implemented");
}
