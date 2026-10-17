import type { ToolChildMessage, ToolChildMessageOf } from "./protocol.ts";
export class WakeAdmissionError extends Error {}
export class WakeAdmission {
	get pending(): number {
		throw new Error("not implemented");
	}
	get blocked(): number {
		throw new Error("not implemented");
	}
	send(_wakeId: string, _bytes: number): Promise<void> {
		throw new Error("not implemented");
	}
	ack(_wakeId: string): void {
		throw new Error("not implemented");
	}
}
export class TraceBudget {
	get dropped(): number {
		throw new Error("not implemented");
	}
	admit(_frame: ToolChildMessageOf<"trace">, _nowMs: number): boolean {
		throw new Error("not implemented");
	}
}
export function isLossy(_message: ToolChildMessage): boolean {
	throw new Error("not implemented");
}
