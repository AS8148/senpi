import type { PayloadRef } from "./protocol.ts";
export function refFilePath(_root: string, _ref: Pick<PayloadRef, "refId" | "generation">): string {
	throw new Error("not implemented");
}
export function spoolDir(_root: string, _generation: number): string {
	throw new Error("not implemented");
}
export async function teardownRefGeneration(_root: string, _generation: number): Promise<void> {
	throw new Error("not implemented");
}
export async function sweepRefGenerations(_root: string, _live: ReadonlySet<number>): Promise<number[]> {
	throw new Error("not implemented");
}
