/**
 * The child side of the reverse bridge (senpi#3566 todo 7): a job's call to the server. Every call is admitted against
 * its job's host-call capacity before it is sent - running, queued FIFO and sent when a slot frees, or refused with a
 * correlated error. Nothing is dropped: each call settles exactly once, by its reply, its refusal, its job's abort or the
 * channel closing.
 */
import { HostCallAdmission } from "./admission.ts";
import type { ToolChildChannel } from "./channel.ts";
import { ToolChildJobError } from "./entry-error.ts";
import type { HostCallKind, ToolChildMessage, ToolChildMessageOf } from "./protocol.ts";

export interface HostCallTarget {
	readonly kind: HostCallKind;
	readonly name?: string;
	readonly args?: unknown;
}

interface PendingCall {
	readonly frame: ToolChildMessageOf<"host_call">;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export class ChildHostCalls {
	readonly #channel: Pick<ToolChildChannel, "send">;
	readonly #admissions = new Map<string, HostCallAdmission>();
	readonly #pending = new Map<string, PendingCall>();
	#next = 0;

	constructor(channel: Pick<ToolChildChannel, "send">) {
		this.#channel = channel;
	}

	/** Calls running and queued for one job (0 for a job with none). */
	load(jobId: string): { active: number; waiting: number } {
		const admission = this.#admissions.get(jobId);
		return { active: admission?.active ?? 0, waiting: admission?.waiting ?? 0 };
	}

	call(jobId: string, target: HostCallTarget, signal: AbortSignal): Promise<unknown> {
		const label = target.name ?? target.kind;
		if (signal.aborted)
			return Promise.reject(new ToolChildJobError("tool_child_cancelled", `${label}: job cancelled`));
		const callId = `h${++this.#next}`;
		const frame: ToolChildMessageOf<"host_call"> = {
			type: "host_call",
			callId,
			jobId,
			kind: target.kind,
			...(target.name === undefined ? {} : { name: target.name }),
			...(target.args === undefined ? {} : { args: target.args }),
		};
		return new Promise((resolve, reject) => {
			const decision = this.#admission(jobId).submit(callId);
			if (decision.state === "refused") {
				this.#forgetIdle(jobId);
				reject(new ToolChildJobError(decision.frame.code, `${label}: host call ${callId} refused`));
				return;
			}
			this.#pending.set(callId, { frame, resolve, reject });
			signal.addEventListener(
				"abort",
				() =>
					this.#settle(callId, (call) =>
						call.reject(new ToolChildJobError("tool_child_cancelled", `${label}: job cancelled`)),
					),
				{ once: true },
			);
			if (decision.state === "active") this.#channel.send(frame);
		});
	}

	/** Routes `host_reply` / `host_call_refused`; returns false for every other frame. */
	handle(frame: ToolChildMessage): boolean {
		if (frame.type === "host_reply") {
			this.#settle(frame.callId, (call) =>
				frame.error === undefined
					? call.resolve(frame.value ?? null)
					: call.reject(new ToolChildJobError("host_call_failed", frame.error)),
			);
			return true;
		}
		if (frame.type === "host_call_refused") {
			this.#settle(frame.callId, (call) =>
				call.reject(new ToolChildJobError(frame.code, `host call ${frame.callId} refused by the server`)),
			);
			return true;
		}
		return false;
	}

	/** The channel closed: every pending call fails, none is left waiting. */
	close(): void {
		for (const callId of [...this.#pending.keys()])
			this.#settle(callId, (call) => call.reject(new ToolChildJobError("tool_child_exited", "the channel closed")));
	}

	#admission(jobId: string): HostCallAdmission {
		let admission = this.#admissions.get(jobId);
		if (admission === undefined) {
			admission = new HostCallAdmission();
			this.#admissions.set(jobId, admission);
		}
		return admission;
	}

	#forgetIdle(jobId: string): void {
		const admission = this.#admissions.get(jobId);
		if (admission !== undefined && admission.active === 0 && admission.waiting === 0) this.#admissions.delete(jobId);
	}

	#settle(callId: string, apply: (call: PendingCall) => void): void {
		const call = this.#pending.get(callId);
		if (call === undefined) return;
		this.#pending.delete(callId);
		const { jobId } = call.frame;
		const promoted = this.#admissions.get(jobId)?.settle(callId);
		this.#forgetIdle(jobId);
		apply(call);
		if (promoted !== undefined) {
			const next = this.#pending.get(promoted);
			if (next !== undefined) this.#channel.send(next.frame);
		}
	}
}
