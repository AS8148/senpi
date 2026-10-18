/**
 * The server's handle on one session's tool child (senpi#3566, plan todo 4).
 *
 * Every spawn is a new generation with its own channel, so a frame from an older generation can never settle a job of
 * a newer one. Each job settles exactly once: by its result, its error, or the child's exit, whichever comes first.
 * When the child dies every pending job of that generation fails with `tool_child_exited`; nothing is re-run here.
 */
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { openChannelListener, type ToolChildChannel } from "./channel.ts";
import { createGenerationBarrier, type GenerationBarrier } from "./client-barrier.ts";
import { generationLedgerPath } from "./descendants.ts";
import { TOOL_CHILD_PROTOCOL_VERSION } from "./entry.ts";
import { spawnToolChild, type ToolChildCommand, toolChildCommand } from "./launch.ts";
import { sweepStaleGenerations } from "./orphan-sweep.ts";
import type { ToolChildMessage } from "./protocol.ts";

export type ToolChildState = "none" | "spawning" | "live" | "retiring" | "dead";

export interface ToolChildStatus {
	readonly state: "spawned" | "exited";
	readonly generation: number;
	readonly pid: number;
}

export class ToolChildError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
		this.name = "ToolChildError";
	}
}

export interface ToolChildClientOptions {
	readonly dir: string;
	readonly cwd: string;
	/** A function is read at every spawn, so each generation sees the current value. */
	readonly env?: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);
	readonly command?: ToolChildCommand;
	readonly readyMs?: number;
	readonly shutdownMs?: number;
	readonly onStatus?: (status: ToolChildStatus) => void;
}

interface Pending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

interface Live {
	readonly generation: number;
	readonly child: ChildProcess;
	readonly channel: ToolChildChannel;
	readonly exited: Promise<void>;
	readonly pending: Map<string, Pending>;
	readonly pongs: Map<number, () => void>;
	readonly barrier: GenerationBarrier;
	ended?: Promise<void>;
}

export class ToolChildClient {
	#state: ToolChildState = "none";
	#generation = 0;
	#nextJob = 0;
	#nextPing = 0;
	#live: Live | undefined;
	#lastEnded: Promise<void> = Promise.resolve();

	readonly #options: ToolChildClientOptions;

	constructor(options: ToolChildClientOptions) {
		this.#options = options;
	}

	get state(): ToolChildState {
		return this.#state;
	}

	get dir(): string {
		return this.#options.dir;
	}

	get generation(): number {
		return this.#generation;
	}

	/** Resolves once the current or last generation's teardown (group sweep, ledger removal) finished. */
	ended(): Promise<void> {
		return this.#lastEnded;
	}

	get pid(): number | undefined {
		return this.#live?.child.pid;
	}

	async start(): Promise<void> {
		if (this.#state === "spawning" || this.#state === "live")
			throw new ToolChildError("tool_child_busy", `already ${this.#state}`);
		const generation = ++this.#generation;
		this.#state = "spawning";
		try {
			await this.#bootstrap(generation);
		} catch (error) {
			// Whatever failed (the listener, the spawn, the hello), the client never stays "spawning": the next job retries.
			if (this.#state === "spawning") this.#state = "dead";
			throw error instanceof ToolChildError
				? error
				: new ToolChildError(
						"tool_child_bootstrap_failed",
						`spawn_failed: ${error instanceof Error ? error.message : String(error)}`,
					);
		}
	}

	async #bootstrap(generation: number): Promise<void> {
		// A crashed predecessor (host or child) may have left owned groups and a ledger this generation would reuse.
		await this.#lastEnded;
		await sweepStaleGenerations(this.#options.dir);
		const listener = await openChannelListener({ dir: this.#options.dir, generation });
		const child = spawnToolChild({
			generation,
			channelEnv: listener.env,
			env: typeof this.#options.env === "function" ? this.#options.env() : (this.#options.env ?? process.env),
			command: this.#options.command ?? (await toolChildCommand()),
			cwd: this.#options.cwd,
			ledgerPath: generationLedgerPath(this.#options.dir, generation),
		});
		let spawnError: Error | undefined;
		child.once("error", (error) => {
			spawnError = error;
		});
		// A spawn that fails (ENOENT, a missing cwd) emits "error" instead of "exit": both end the child.
		const exited = Promise.race([once(child, "exit"), once(child, "error")]).then(
			() => undefined,
			() => undefined,
		);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), this.#options.readyMs ?? 10_000);
		});
		const hello = listener.accepted.then((channel) =>
			firstMessage(channel).then((message) => ({ channel, message })),
		);
		const outcome = await Promise.race([hello, exited.then(() => "exited" as const), timedOut]);
		clearTimeout(timer);
		await listener.close();
		if (outcome === "timeout" || outcome === "exited") {
			this.#kill(child);
			this.#state = "dead";
			throw new ToolChildError(
				"tool_child_bootstrap_failed",
				outcome === "timeout"
					? "ready_timeout"
					: spawnError
						? `spawn_failed: ${spawnError.message}`
						: "exited_before_ready",
			);
		}
		const { channel, message } = outcome;
		if (
			message.type !== "hello" ||
			message.generation !== generation ||
			message.protocol !== TOOL_CHILD_PROTOCOL_VERSION
		) {
			this.#kill(child);
			this.#state = "dead";
			throw new ToolChildError("tool_child_bootstrap_failed", "version_mismatch");
		}
		const pending = new Map<string, Pending>();
		const barrier = createGenerationBarrier({
			dir: this.#options.dir,
			generation,
			channel,
			onViolation: (violation) => {
				const failure = new ToolChildError(
					"tool_child_barrier_violation",
					`${violation.launchId}: ${violation.reason}`,
				);
				if (violation.jobId !== undefined) settle({ pending }, violation.jobId, (p) => p.reject(failure));
				this.#kill(child);
			},
		});
		const live: Live = { generation, child, channel, exited, pending, pongs: new Map(), barrier };
		this.#live = live;
		this.#state = "live";
		channel.onMessage((frame) => this.#onFrame(live, frame));
		void exited.then(() => this.#onExit(live));
		this.#options.onStatus?.({ state: "spawned", generation, pid: child.pid ?? -1 });
	}

	run(kind: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
		const live = this.#live;
		if (this.#state !== "live" || live === undefined)
			return Promise.reject(new ToolChildError("tool_child_unavailable", this.#state));
		const jobId = `j${++this.#nextJob}`;
		return new Promise((resolve, reject) => {
			live.pending.set(jobId, { resolve, reject });
			signal?.addEventListener("abort", () => live.channel.send({ type: "cancel", jobId }), { once: true });
			live.channel.send({ type: "job", jobId, kind, args });
		});
	}

	ping(): Promise<number> {
		const live = this.#live;
		if (live === undefined) return Promise.reject(new ToolChildError("tool_child_unavailable", this.#state));
		const seq = ++this.#nextPing;
		return new Promise((resolve) => {
			live.pongs.set(seq, () => resolve(seq));
			live.channel.send({ type: "ping", seq });
		});
	}

	async close(): Promise<void> {
		const live = this.#live;
		if (live === undefined) return;
		this.#state = "retiring";
		live.channel.send({ type: "shutdown" });
		const graceful = await Promise.race([
			live.exited.then(() => true),
			delay(this.#options.shutdownMs ?? 2_000).then(() => false),
		]);
		if (!graceful) this.#kill(live.child);
		await live.exited;
		await live.ended;
	}

	#onFrame(live: Live, frame: ToolChildMessage): void {
		if (this.#live !== live) return;
		if (live.barrier.handle(frame)) return;
		switch (frame.type) {
			case "result":
				settle(live, frame.jobId, (p) => p.resolve(frame.value));
				return;
			case "job_error":
			case "job_refused":
				settle(live, frame.jobId, (p) =>
					p.reject(new ToolChildError(frame.code, frame.type === "job_error" ? frame.message : "refused")),
				);
				return;
			case "pong": {
				const done = live.pongs.get(frame.seq);
				live.pongs.delete(frame.seq);
				done?.();
				return;
			}
			default:
				return;
		}
	}

	#onExit(live: Live): void {
		const failure = new ToolChildError("tool_child_exited", `generation ${live.generation} exited`);
		for (const [jobId, pending] of live.pending) {
			live.pending.delete(jobId);
			pending.reject(failure);
		}
		live.channel.close();
		this.#kill(live.child);
		if (this.#live === live) {
			this.#live = undefined;
			this.#state = "dead";
		}
		this.#options.onStatus?.({ state: "exited", generation: live.generation, pid: live.child.pid ?? -1 });
		live.ended = live.barrier.teardown(undefined).then(() => undefined);
		this.#lastEnded = live.ended;
	}

	#kill(child: ChildProcess): void {
		const pid = child.pid;
		if (pid === undefined) return;
		try {
			if (process.platform === "win32") child.kill("SIGKILL");
			else process.kill(-pid, "SIGKILL");
		} catch {
			// The child's group is already gone.
		}
	}
}

function settle(live: Pick<Live, "pending">, jobId: string, apply: (pending: Pending) => void): void {
	const pending = live.pending.get(jobId);
	if (pending === undefined) return;
	live.pending.delete(jobId);
	apply(pending);
}

/** The channel's first frame; the subscription ends with it (frames after it belong to the live client's handler). */
function firstMessage(channel: ToolChildChannel): Promise<ToolChildMessage> {
	return new Promise((resolve) => {
		let done = false;
		let unsubscribe: (() => void) | undefined;
		unsubscribe = channel.onMessage((message) => {
			if (done) return;
			done = true;
			resolve(message);
			unsubscribe?.();
		});
		// onMessage replays a queued frame synchronously, before it returned the unsubscribe function.
		if (done) unsubscribe();
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
