/**
 * The server side of the reverse bridge (senpi#3566 todo 7). Each `host_call` from the child is admitted on receipt
 * against its job's capacity - the same one the child enforces - and run, queued FIFO, or refused with
 * `host_call_refused` naming its `callId`; every admitted call is answered exactly once with `host_reply`. A job that
 * ends signals its running calls and answers its queued calls without running them.
 */
import { HostCallAdmission } from "./admission.ts";
import type { ToolChildChannel } from "./channel.ts";
import type { HostCallKind, ToolChildMessage, ToolChildMessageOf } from "./protocol.ts";

export interface HostCallRequest {
	readonly callId: string;
	readonly jobId: string;
	readonly kind: HostCallKind;
	readonly name: string | undefined;
	readonly args: unknown;
	readonly signal: AbortSignal;
	/** What the job's dispatcher attached to it (the calling tool call, for a session); undefined when none. */
	readonly context: unknown;
}

export type HostCallHandler = (request: HostCallRequest) => Promise<unknown>;

/** The job context a request carries; ServerHostCalls reads it per call. */
export type HostCallContextOf = (jobId: string) => unknown;

interface ServerCall {
	readonly frame: ToolChildMessageOf<"host_call">;
	readonly abort: AbortController;
}

export class ServerHostCalls {
	readonly #channel: Pick<ToolChildChannel, "send">;
	readonly #handler: HostCallHandler;
	readonly #admissions = new Map<string, HostCallAdmission>();
	readonly #calls = new Map<string, ServerCall>();

	readonly #contextOf: HostCallContextOf;

	constructor(
		channel: Pick<ToolChildChannel, "send">,
		handler: HostCallHandler,
		contextOf: HostCallContextOf = () => undefined,
	) {
		this.#channel = channel;
		this.#handler = handler;
		this.#contextOf = contextOf;
	}

	/** Calls running and queued for one job (0 for a job with none). */
	load(jobId: string): { active: number; waiting: number } {
		const admission = this.#admissions.get(jobId);
		return { active: admission?.active ?? 0, waiting: admission?.waiting ?? 0 };
	}

	/** Takes a `host_call`; returns false for every other frame. */
	handle(frame: ToolChildMessage): boolean {
		if (frame.type !== "host_call") return false;
		const decision = this.#admission(frame.jobId).submit(frame.callId);
		if (decision.state === "refused") {
			this.#forgetIdle(frame.jobId);
			this.#channel.send(decision.frame);
			return true;
		}
		this.#calls.set(frame.callId, { frame, abort: new AbortController() });
		if (decision.state === "active") this.#run(frame.callId);
		return true;
	}

	/** The job ended: its running calls are signalled, its queued calls are answered without running. */
	endJob(jobId: string): void {
		for (const call of this.#calls.values()) if (call.frame.jobId === jobId) call.abort.abort();
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

	#run(callId: string): void {
		const call = this.#calls.get(callId);
		if (call === undefined) return;
		const { frame } = call;
		const label = frame.name ?? frame.kind;
		const answered = call.abort.signal.aborted
			? Promise.reject(new Error(`${label}: the job ended before this call ran`))
			: this.#handler({
					callId,
					jobId: frame.jobId,
					kind: frame.kind,
					name: frame.name,
					args: frame.args,
					signal: call.abort.signal,
					context: this.#contextOf(frame.jobId),
				});
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
		const call = this.#calls.get(callId);
		if (call === undefined) return;
		this.#calls.delete(callId);
		this.#channel.send(reply);
		const { jobId } = call.frame;
		const promoted = this.#admissions.get(jobId)?.settle(callId);
		this.#forgetIdle(jobId);
		if (promoted !== undefined) this.#run(promoted);
	}
}
