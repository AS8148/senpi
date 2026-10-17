import type { PayloadRef, RefControl, RefNackReason } from "./protocol.ts";
export class PayloadRefError extends Error {}
export interface PayloadRefWriterOptions {
	root: string;
	generation: number;
	budget?: number | undefined;
	now?: () => number;
}
export class PayloadRefWriter {
	readonly generation: number;
	constructor(options: PayloadRefWriterOptions) {
		this.generation = options.generation;
	}
	get budget(): number {
		throw new Error("not implemented");
	}
	get ownedBytes(): number {
		throw new Error("not implemented");
	}
	async create(_bytes: Uint8Array): Promise<PayloadRef> {
		throw new Error("not implemented");
	}
	async handle(_control: RefControl): Promise<void> {
		throw new Error("not implemented");
	}
	pendingIds(): string[] {
		throw new Error("not implemented");
	}
	overdue(): string[] {
		throw new Error("not implemented");
	}
	async teardown(): Promise<void> {
		throw new Error("not implemented");
	}
}
export interface PayloadRefReaderOptions {
	root: string;
	generation: number;
	budget?: number | undefined;
	send: (control: RefControl) => void;
}
export type RefAcceptance = { ok: true } | { ok: false; reason: RefNackReason };
export class PayloadRefReader {
	constructor(_options: PayloadRefReaderOptions) {}
	async accept(_ref: PayloadRef, _signal?: AbortSignal): Promise<RefAcceptance> {
		throw new Error("not implemented");
	}
	refuse(_ref: PayloadRef, _reason: RefNackReason): void {
		throw new Error("not implemented");
	}
	async consume(_refId: string): Promise<Uint8Array> {
		throw new Error("not implemented");
	}
	ownedIds(): string[] {
		throw new Error("not implemented");
	}
}
