/**
 * The child half of the execution barrier (senpi#3566, plan todo 4). Every launch path asks the gate for a slot, which
 * sends `launch` with the containment handle; the server records it and acknowledges. The launch path then stores its
 * invoke tick immediately before the real call and calls `invoking`, and the gate publishes `launch_proof` from the
 * shared clock without waiting for the call to return. `done` reports completion separately, with no deadline.
 */
import { BarrierClock } from "./barrier-clock.ts";
import type { ToolChildChannel } from "./channel.ts";
import type { LaunchApi, LaunchContainment, LaunchLifetime, LaunchOrigin, ToolChildMessage } from "./protocol.ts";

export interface LaunchRequest {
	readonly jobId: string;
	readonly origin: LaunchOrigin;
	readonly api: LaunchApi;
	readonly containment: LaunchContainment;
	readonly lifetime: LaunchLifetime;
	readonly pid?: number;
	readonly pgid?: number;
}

export interface GatedLaunch {
	readonly launchId: string;
	readonly slot: number;
	/** Resolves when the server's `launch_ack` has been recorded on the shared clock. */
	readonly acked: Promise<void>;
}

export class LaunchGateError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "LaunchGateError";
		this.code = code;
	}
}

export class LaunchGate {
	readonly clock: BarrierClock;
	readonly #channel: ToolChildChannel;
	readonly #slots = new Map<string, { slot: number; ack: () => void }>();
	#next = 0;

	constructor(channel: ToolChildChannel, clock: BarrierClock = BarrierClock.create()) {
		this.#channel = channel;
		this.clock = clock;
	}

	request(request: LaunchRequest): GatedLaunch {
		const slot = this.clock.claimSlot();
		if (slot === undefined)
			throw new LaunchGateError("tool_child_launch_capacity", `${this.clock.slots} launches in flight`);
		const launchId = `L${process.pid}-${++this.#next}`;
		let ack!: () => void;
		const acked = new Promise<void>((resolve) => {
			ack = resolve;
		});
		this.#slots.set(launchId, { slot, ack });
		this.#channel.send({ type: "launch", launchId, ...request });
		return { launchId, slot, acked };
	}

	/** Protocol loop: a frame the gate owns. Returns false for frames it does not handle. */
	handle(message: ToolChildMessage): boolean {
		if (message.type === "launch_ack") {
			const entry = this.#slots.get(message.launchId);
			if (entry !== undefined) {
				this.clock.recordAck(entry.slot);
				entry.ack();
			}
			return true;
		}
		if (message.type === "slot_query") {
			const entry = this.#slots.get(message.launchId);
			const state =
				entry === undefined ? { ackTick: null, invokeTick: null, invocations: 0 } : this.clock.read(entry.slot);
			this.#channel.send({ type: "slot_state", launchId: message.launchId, ...state });
			return true;
		}
		return false;
	}

	/** Main-thread launch path: records the invoke tick and publishes the proof. Call immediately before the real call. */
	invokeNow(launchId: string): void {
		const entry = this.#slots.get(launchId);
		if (entry === undefined) throw new LaunchGateError("tool_child_launch_unknown", launchId);
		this.clock.recordInvoke(entry.slot);
		this.invoking(launchId);
	}

	/** Protocol loop: a launch path (any thread) has stored its invoke tick; publish the proof from the clock. */
	invoking(launchId: string): void {
		const entry = this.#slots.get(launchId);
		if (entry === undefined) return;
		const state = this.clock.read(entry.slot);
		if (state.invokeTick === null) return;
		this.#channel.send({ type: "launch_proof", launchId, ackTick: state.ackTick, invokeTick: state.invokeTick });
	}

	done(launchId: string, outcome: { readonly exitCode?: number; readonly signal?: string }): void {
		const entry = this.#slots.get(launchId);
		if (entry === undefined) return;
		this.#slots.delete(launchId);
		this.clock.releaseSlot(entry.slot);
		this.#channel.send({
			type: "launch_done",
			launchId,
			...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
			...(outcome.signal === undefined ? {} : { signal: outcome.signal }),
		});
	}
}
