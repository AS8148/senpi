/**
 * Server-side execution barrier (senpi#3566, plan todo 4). For every `launch` the server records the containment handle
 * durably, then acknowledges. The child must then deliver `launch_proof` with `ackTick < invokeTick` from its shared
 * clock within `proofMs` of the ack. A missing proof, a null `ackTick` or an unordered pair is a
 * `tool_child_barrier_violation`. `launch_done` has no deadline: a correctly gated command may run as long as it likes.
 */
import { proofIsOrdered } from "./barrier-clock.ts";
import type { DescendantEntry, DescendantsLedger, LaunchLog } from "./descendants.ts";
import type { ToolChildMessageOf } from "./protocol.ts";

export const LAUNCH_PROOF_MS = 5_000;

export interface BarrierViolation {
	readonly launchId: string;
	readonly jobId: string | undefined;
	readonly reason: "proof_missing" | "proof_unacked" | "proof_unordered" | "proof_unknown_launch";
}

export interface LaunchEnforcerOptions {
	readonly generation: number;
	readonly ledger: DescendantsLedger;
	readonly log: LaunchLog;
	readonly sendAck: (launchId: string) => void;
	readonly onViolation: (violation: BarrierViolation) => void;
	readonly leaderStart: (pid: number) => Promise<string | undefined>;
	/** Test-only gate: resolves when the test releases this launch's ack (`HOLD_LAUNCH_ACK`). */
	readonly holdAck?: (launchId: string) => Promise<void>;
	readonly setTimer?: (fn: () => void, ms: number) => () => void;
	readonly proofMs?: number;
}

interface Inflight {
	readonly jobId: string;
	acked: boolean;
	cancelTimer: (() => void) | undefined;
	proven: boolean;
}

export class LaunchEnforcer {
	readonly #options: LaunchEnforcerOptions;
	readonly #inflight = new Map<string, Inflight>();
	readonly #recordings = new Set<Promise<void>>();
	#violated = false;

	constructor(options: LaunchEnforcerOptions) {
		this.#options = options;
	}

	async onLaunch(frame: ToolChildMessageOf<"launch">): Promise<void> {
		const inflight: Inflight = { jobId: frame.jobId, acked: false, cancelTimer: undefined, proven: false };
		this.#inflight.set(frame.launchId, inflight);
		const recording = this.#record(frame);
		this.#recordings.add(recording);
		try {
			await recording;
		} finally {
			this.#recordings.delete(recording);
		}
		await this.#options.holdAck?.(frame.launchId);
		if (this.#violated || inflight.proven) return;
		inflight.acked = true;
		this.#options.sendAck(frame.launchId);
		await this.#options.log.record({ type: "launch_ack", launchId: frame.launchId });
		const setTimer = this.#options.setTimer ?? defaultTimer;
		inflight.cancelTimer = setTimer(
			() => this.#violate(frame.launchId, "proof_missing"),
			this.#options.proofMs ?? LAUNCH_PROOF_MS,
		);
	}

	/**
	 * Resolves once every launch received so far is in the ledger. Teardown reads the ledger after this: a launch whose
	 * entry was still being written when the child was killed (a violation kills at once) is swept like any other.
	 */
	async recorded(): Promise<void> {
		await Promise.allSettled([...this.#recordings]);
	}

	async #record(frame: ToolChildMessageOf<"launch">): Promise<void> {
		const leaderStart =
			frame.pgid === undefined ? undefined : await this.#options.leaderStart(frame.pgid).catch(() => undefined);
		const entry: DescendantEntry = {
			launchId: frame.launchId,
			generation: this.#options.generation,
			origin: frame.origin,
			api: frame.api,
			containment: frame.containment,
			lifetime: frame.lifetime,
			...(frame.pid === undefined ? {} : { pid: frame.pid }),
			...(frame.pgid === undefined ? {} : { pgid: frame.pgid }),
			...(leaderStart === undefined ? {} : { leaderStart }),
			atMs: Date.now(),
		};
		await this.#options.log.record({ ...frame });
		await this.#options.ledger.append(entry);
	}

	onProof(frame: ToolChildMessageOf<"launch_proof">): void {
		void this.#options.log.record({ ...frame });
		const inflight = this.#inflight.get(frame.launchId);
		if (inflight === undefined) {
			this.#violate(frame.launchId, "proof_unknown_launch");
			return;
		}
		inflight.proven = true;
		inflight.cancelTimer?.();
		if (frame.ackTick === null || !inflight.acked) this.#violate(frame.launchId, "proof_unacked");
		else if (!proofIsOrdered({ ackTick: frame.ackTick, invokeTick: frame.invokeTick }))
			this.#violate(frame.launchId, "proof_unordered");
	}

	onDone(frame: ToolChildMessageOf<"launch_done">): void {
		void this.#options.log.record({ ...frame });
	}

	dispose(): void {
		for (const inflight of this.#inflight.values()) inflight.cancelTimer?.();
		this.#inflight.clear();
	}

	#violate(launchId: string, reason: BarrierViolation["reason"]): void {
		const jobId = this.#inflight.get(launchId)?.jobId;
		void this.#options.log.record({ type: "violation", code: "tool_child_barrier_violation", launchId, reason });
		if (this.#violated) return;
		this.#violated = true;
		this.dispose();
		this.#options.onViolation({ launchId, jobId, reason });
	}
}

function defaultTimer(fn: () => void, ms: number): () => void {
	const timer = setTimeout(fn, ms);
	timer.unref?.();
	return () => clearTimeout(timer);
}
