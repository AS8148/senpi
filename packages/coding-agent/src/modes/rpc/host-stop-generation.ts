import type { RegisteredHost } from "./host-daemon-registration.ts";
import { parseJson } from "./host-daemon-state.ts";

/** The registration the operator saw and authorized, never a newly resolved target. */
export interface HostStopGeneration {
	readonly instanceId: string;
	readonly generation: number;
	readonly pid: number;
	readonly processStartTime: string;
}

export function parseHostStopGeneration(text: string): HostStopGeneration | undefined {
	const value = parseJson(text);
	if (
		!value ||
		typeof value.instanceId !== "string" ||
		value.instanceId.length === 0 ||
		typeof value.generation !== "number" ||
		!Number.isSafeInteger(value.generation) ||
		value.generation < 0 ||
		typeof value.pid !== "number" ||
		!Number.isSafeInteger(value.pid) ||
		value.pid <= 0 ||
		typeof value.processStartTime !== "string" ||
		value.processStartTime.length === 0
	)
		return undefined;
	return {
		instanceId: value.instanceId,
		generation: value.generation,
		pid: value.pid,
		processStartTime: value.processStartTime,
	};
}

export function matchesStopGeneration(registered: RegisteredHost | undefined, expected: HostStopGeneration): boolean {
	return (
		registered?.instanceId === expected.instanceId &&
		registered.generation === expected.generation &&
		registered.record.pid === expected.pid &&
		registered.record.processStartTime === expected.processStartTime
	);
}
