/**
 * The child side of the reverse bridge (senpi#3566 todo 7): a job's call to the server. Every call is admitted against
 * the shared host-call capacity before it is sent - running, queued FIFO and sent when a slot frees, or refused with a
 * correlated error. Nothing is dropped: each call settles exactly once, by its reply, its refusal, its job's abort or the
 * channel closing.
 */
import { HostCallAdmission } from "./admission.ts";
import type { ToolChildChannel } from "./channel.ts";
import { ToolChildJobError } from "./entry-error.ts";
import type { ToolChildMessage, ToolChildMessageOf } from "./protocol.ts";

interface PendingCall {
	readonly frame: ToolChildMessageOf<"host_call">;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

export class ChildHostCalls {
	readonly #channel: Pick<ToolChildChannel, "send">;
	readonly #admission = new HostCallAdmission();
	readonly #pending = new Map<string, PendingCall>();
	#next = 0;

	constructor(channel: Pick<ToolChildChannel, "send">) {
		this.#channel = channel;
	}

	get active(): number {
		return this.#admission.active;
	}

	get waiting(): number {
		return this.#admission.waiting;
	}

	call(jobId: string, tool: string, args: unknown, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted)
			return Promise.reject(new ToolChildJobError("tool_child_cancelled", `${tool}: job cancelled`));
		const callId = `h${++this.#next}`;
		const frame: ToolChildMessageOf<"host_call"> = { type: "host_call", callId, jobId, tool, args };
		return new Promise((resolve, reject) => {
			const decision = this.#admission.submit(callId);
			if (decision.state === "refused") {
				reject(new ToolChildJobError(decision.frame.code, `${tool}: host call ${callId} refused`));
				return;
			}
			this.#pending.set(callId, { frame, resolve, reject });
			signal.addEventListener(
				"abort",
				() =>
					this.#settle(callId, (call) =>
						call.reject(new ToolChildJobError("tool_child_cancelled", `${tool}: job cancelled`)),
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

	#settle(callId: string, apply: (call: PendingCall) => void): void {
		const call = this.#pending.get(callId);
		if (call === undefined) return;
		this.#pending.delete(callId);
		const promoted = this.#admission.settle(callId);
		apply(call);
		if (promoted !== undefined) {
			const next = this.#pending.get(promoted);
			if (next !== undefined) this.#channel.send(next.frame);
		}
	}
}
