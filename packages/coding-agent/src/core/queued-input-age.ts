export interface OutlivedQueuedInput {
	readonly queuedId: string;
	readonly ageMs: number;
}

interface QueuedAt {
	readonly runsStarted: number;
	readonly atMs: number;
}

/**
 * Tracks when each queued input was queued relative to agent runs, so input that outlives a completed run is
 * reported instead of waiting silently (senpi#4036). Input queued while idle is drained when the next run starts,
 * and input queued during a run is drained at that run's turn boundaries, so neither is reported in normal flow.
 */
export class QueuedInputAges {
	#runsStarted = 0;
	readonly #queuedAt = new Map<string, QueuedAt>();
	readonly #reported = new Set<string>();

	noteRunStarted(): void {
		this.#runsStarted += 1;
	}

	noteQueued(queuedId: string, nowMs: number): void {
		this.#queuedAt.set(queuedId, { runsStarted: this.#runsStarted, atMs: nowMs });
	}

	takeOutlived(stillQueued: readonly string[], nowMs: number): OutlivedQueuedInput[] {
		const live = new Set(stillQueued);
		for (const queuedId of this.#queuedAt.keys()) {
			if (live.has(queuedId)) continue;
			this.#queuedAt.delete(queuedId);
			this.#reported.delete(queuedId);
		}
		const outlived: OutlivedQueuedInput[] = [];
		for (const queuedId of stillQueued) {
			const queuedAt = this.#queuedAt.get(queuedId);
			if (queuedAt === undefined || this.#reported.has(queuedId)) continue;
			if (queuedAt.runsStarted >= this.#runsStarted) continue;
			this.#reported.add(queuedId);
			outlived.push({ queuedId, ageMs: nowMs - queuedAt.atMs });
		}
		return outlived;
	}
}
