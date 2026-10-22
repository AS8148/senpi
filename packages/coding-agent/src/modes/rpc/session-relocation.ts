/**
 * `session_relocation` (docs/rpc.md "Continuing a session on another computer"): the session asks the client that
 * offers relocation with `host_request`, the client answers with `host_response`, and an accepted move is announced
 * with `relocation_due` once the run that asked for it settles. The engine never interrupts that run and never moves
 * anything itself: the host runs the existing `release_session` reason `move` and `move_session` steps.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { isPlainId } from "../../core/session-move/bundle.ts";
import {
	RELOCATION_NOT_OFFERED,
	type RelocationRefused,
	type RelocationRequest,
	type RelocationRequestResult,
	type RelocationTarget,
	type RelocationTargetsResult,
	type SessionRelocationHost,
} from "../../core/session-relocation.ts";
import type { RpcHostRequest, RpcHostResponse, RpcRelocationDueEvent } from "./rpc-types.ts";

/** Longest the session waits for the host's answer before refusing the request itself. */
export const HOST_ANSWER_TIMEOUT_MS = 60_000;

type Answer = { readonly data: unknown } | RelocationRefused;
type Scheduled = { readonly moveId: string; readonly target: string; readonly reason: string };

export interface RpcSessionRelocationDeps {
	readonly session: Pick<AgentSession, "sessionFile" | "subscribe" | "isStreaming">;
	/** `prompt` calls not yet returned; `release_session` counts them as a running turn (`busy: ["prompt"]`). */
	readonly pendingPrompts: () => readonly Promise<unknown>[];
	/** Whether the client bound to this session advertised `session_relocation`. */
	readonly offered: () => boolean;
	readonly output: (record: object) => void;
	readonly outputEvent: (record: object) => void;
}

const refused = (reason: string, detail: string): RelocationRefused => ({ status: "refused", reason, detail });
const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;

function parseTarget(value: unknown): RelocationTarget | undefined {
	const fields = record(value);
	if (typeof fields?.name !== "string" || fields.name === "" || typeof fields.online !== "boolean") return undefined;
	return {
		name: fields.name,
		online: fields.online,
		...(typeof fields.capacity === "string" ? { capacity: fields.capacity } : {}),
		...(typeof fields.aboutToSleep === "boolean" ? { aboutToSleep: fields.aboutToSleep } : {}),
	};
}

export class RpcSessionRelocation implements SessionRelocationHost {
	private readonly deps: RpcSessionRelocationDeps;
	private readonly pending = new Map<string, (answer: Answer) => void>();
	private readonly unsubscribe: () => void;
	private scheduled: Scheduled | undefined;
	private requesting = false;

	constructor(deps: RpcSessionRelocationDeps) {
		this.deps = deps;
		this.unsubscribe = deps.session.subscribe((event) => {
			if (event.type === "agent_settled" && this.scheduled !== undefined) void this.announceWhenReleasable();
		});
	}

	async targets(signal?: AbortSignal): Promise<RelocationTargetsResult> {
		if (!this.deps.offered()) return RELOCATION_NOT_OFFERED;
		const answer = await this.ask({ method: "list_relocation_targets" }, signal);
		if ("status" in answer) return answer;
		const raw = record(answer.data)?.targets;
		const targets = Array.isArray(raw) ? raw.map(parseTarget) : undefined;
		if (targets === undefined || targets.some((target) => target === undefined))
			return refused("invalid_host_answer", "the app sent a list of computers this session cannot read");
		return { status: "listed", targets: targets.filter((target) => target !== undefined) };
	}

	async request(request: RelocationRequest, signal?: AbortSignal): Promise<RelocationRequestResult> {
		if (!this.deps.offered()) return RELOCATION_NOT_OFFERED;
		if (this.deps.session.sessionFile === undefined)
			return { status: "unavailable", reason: "not_releasable", detail: "this session is not saved to a file" };
		if (this.scheduled !== undefined || this.requesting)
			return refused(
				"already_scheduled",
				`a move to ${this.scheduled?.target ?? "another computer"} is already set for the end of this turn`,
			);
		this.requesting = true;
		try {
			const answer = await this.ask(
				{ method: "relocate_session", target: request.target, reason: request.reason },
				signal,
			);
			if ("status" in answer) return answer;
			return this.settleRequest(request, record(answer.data));
		} finally {
			this.requesting = false;
		}
	}

	/** Settles one `host_response`; `false` when no request of this session is waiting for that id. */
	respond(frame: RpcHostResponse): boolean {
		const resolve = this.pending.get(frame.id);
		if (resolve === undefined) return false;
		resolve(typeof frame.error === "string" ? refused("host_error", frame.error) : { data: frame.data });
		return true;
	}

	dispose(): void {
		this.unsubscribe();
		this.scheduled = undefined;
		for (const resolve of [...this.pending.values()]) resolve(refused("session_closed", "this session was closed"));
	}

	private settleRequest(
		request: RelocationRequest,
		data: Record<string, unknown> | undefined,
	): RelocationRequestResult {
		if (data?.accepted === false)
			return refused(
				typeof data.reason === "string" && data.reason !== "" ? data.reason : "declined",
				typeof data.detail === "string" && data.detail !== "" ? data.detail : "the app declined the move",
			);
		if (data?.accepted !== true || !isPlainId(data.moveId))
			return refused("invalid_host_answer", "the app accepted the move without a usable move id");
		const target = typeof data.target === "string" && data.target !== "" ? data.target : request.target;
		this.scheduled = { moveId: data.moveId, target, reason: request.reason };
		return { status: "scheduled", target, moveId: data.moveId };
	}

	/** After the run settled, waits out the prompt calls behind it, so a `release_session` answering the notice finds the session quiet. */
	private async announceWhenReleasable(): Promise<void> {
		for (let calls = this.deps.pendingPrompts(); calls.length > 0; calls = this.deps.pendingPrompts())
			await Promise.allSettled(calls);
		const due = this.scheduled;
		// A new run took over meanwhile: its own settle announces the move.
		if (due === undefined || this.deps.session.isStreaming) return;
		this.scheduled = undefined;
		this.deps.outputEvent({ type: "relocation_due", ...due } satisfies RpcRelocationDueEvent);
	}

	private ask(
		fields: { method: "list_relocation_targets" } | { method: "relocate_session"; target: string; reason: string },
		signal?: AbortSignal,
	): Promise<Answer> {
		if (signal?.aborted) return Promise.resolve(refused("cancelled", "the request was cancelled"));
		const id = `hr_${crypto.randomUUID()}`;
		return new Promise<Answer>((resolve) => {
			const finish = (answer: Answer): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				resolve(answer);
			};
			const onAbort = (): void => finish(refused("cancelled", "the request was cancelled"));
			const timer = setTimeout(
				() => finish(refused("no_answer", "the app did not answer in time")),
				HOST_ANSWER_TIMEOUT_MS,
			);
			this.pending.set(id, finish);
			signal?.addEventListener("abort", onAbort, { once: true });
			this.deps.output({ type: "host_request", id, ...fields } satisfies RpcHostRequest);
		});
	}
}

export function answerHostResponse(frame: RpcHostResponse, relocation: RpcSessionRelocation | undefined): object {
	const reply = { id: frame.id, type: "response", command: "host_response" } as const;
	if (typeof frame.id !== "string" || frame.id === "")
		return { ...reply, success: false, error: "invalid_host_response" };
	return relocation?.respond(frame) === true
		? { ...reply, success: true }
		: { ...reply, success: false, error: "unknown_host_request" };
}

export function isHostResponse(value: unknown): value is RpcHostResponse {
	return record(value)?.type === "host_response";
}
