import type { ToolChildMessageOf } from "./protocol.ts";
export function hostCallCapacity(): number {
	throw new Error("not implemented");
}
export type HostCallDecision =
	| { state: "active" }
	| { state: "waiting" }
	| { state: "refused"; frame: ToolChildMessageOf<"host_call_refused"> };
export class HostCallAdmission {
	get active(): number {
		throw new Error("not implemented");
	}
	get waiting(): number {
		throw new Error("not implemented");
	}
	submit(_callId: string): HostCallDecision {
		throw new Error("not implemented");
	}
	settle(_callId: string): string | undefined {
		throw new Error("not implemented");
	}
}
export type JobDecision = { admitted: true } | { admitted: false; frame: ToolChildMessageOf<"job_refused"> };
export class JobAdmission {
	admit(_jobId: string, _parentJobId?: string): JobDecision {
		throw new Error("not implemented");
	}
	finish(_jobId: string): void {
		throw new Error("not implemented");
	}
}
