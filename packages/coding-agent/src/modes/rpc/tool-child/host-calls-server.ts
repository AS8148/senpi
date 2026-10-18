/**
 * The server side of the reverse bridge (senpi#3566 todo 7). Each `host_call` from the child is admitted on receipt
 * against the same capacity the child enforces - run, queued FIFO, or refused with `host_call_refused` naming its
 * `callId` - and answered exactly once with `host_reply`. A job that ends cancels its calls still waiting; a running call
 * is told through its signal and still answers.
 */
import { HostCallAdmission } from "./admission.ts";
import type { ToolChildChannel } from "./channel.ts";
import type { ToolChildMessage, ToolChildMessageOf } from "./protocol.ts";

export interface HostCallRequest {
	readonly callId: string;
	readonly jobId: string;
	readonly tool: string;
	readonly args: unknown;
	readonly signal: AbortSignal;
}

export type HostCallHandler = (request: HostCallRequest) => Promise<unknown>;

interface ServerCall {
	readonly frame: ToolChildMessageOf<"host_call">;
	readonly abort: AbortController;
}

export class ServerHostCalls {
	readonly #channel: Pick<ToolChildChannel, "send">;
	readonly #handler: HostCallHandler;
	readonly #admission = new HostCallAdmission();
	readonly #calls = new Map<string, ServerCall>();

	constructor(channel: Pick<ToolChildChannel, "send">, handler: HostCallHandler) {
		this.#channel = channel;
		this.#handler = handler;
	}

	get active(): number {
		return this.#admission.active;
	}

	get waiting(): number {
		return this.#admission.waiting;
	}

	/** Takes a `host_call`; returns false for every other frame. */
	handle(frame: ToolChildMessage): boolean {
		if (frame.type !== "host_call") return false;
		const decision = this.#admission.submit(frame.callId);
		if (decision.state === "refused") {
			this.#channel.send(decision.frame);
			return true;
		}
		this.#calls.set(frame.callId, { frame, abort: new AbortController() });
		if (decision.state === "active") this.#run(frame.callId);
		return true;
	}

	/** The job ended: its running calls are signalled, its queued calls are answered without running. */
	endJob(jobId: string): void {
		for (const [callId, call] of this.#calls) {
			if (call.frame.jobId !== jobId) continue;
			call.abort.abort();
		}
	}

	#run(callId: string): void {
		const call = this.#calls.get(callId);
		if (call === undefined) return;
		const { frame } = call;
		const answered = call.abort.signal.aborted
			? Promise.reject(new Error(`${frame.tool}: the job ended before this call ran`))
			: this.#handler({ callId, jobId: frame.jobId, tool: frame.tool, args: frame.args, signal: call.abort.signal });
		void answered.then(
			(value) => this.#answer(callId, { type: "host_reply", callId, value: value ?? null }),
			(error: unknown) =>
				this.#answer(callId, {
					type: "host_reply",
					callId,
					error: error instanceof Error ? error.message : String(error),
				}),
		);
	}

	#answer(callId: string, reply: ToolChildMessageOf<"host_reply">): void {
		if (!this.#calls.delete(callId)) return;
		this.#channel.send(reply);
		const promoted = this.#admission.settle(callId);
		if (promoted !== undefined) this.#run(promoted);
	}
}
