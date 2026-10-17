/**
 * Cooperative time slicing for work that walks a whole transcript on a shared event loop.
 * Work checks `due` between items and awaits `yield()` once its slice is spent, so sockets,
 * timers and other sessions run between slices (senpi#3518).
 */
export const DEFAULT_SLICE_BUDGET_MS = 8;

let sliceClock: () => number = () => performance.now();

/** Test seam: a clock that advances per call makes slicing deterministic. */
export function setSliceClockForTesting(clock: () => number): () => void {
	const previous = sliceClock;
	sliceClock = clock;
	return () => {
		sliceClock = previous;
	};
}

export class EventLoopSlicer {
	private readonly budgetMs: number;
	private sliceStart = sliceClock();

	constructor(budgetMs: number = DEFAULT_SLICE_BUDGET_MS) {
		this.budgetMs = budgetMs;
	}

	get due(): boolean {
		return sliceClock() - this.sliceStart >= this.budgetMs;
	}

	/** `setImmediate` rather than a microtask: only a macrotask lets pending I/O callbacks run. */
	async yield(): Promise<void> {
		await new Promise<void>((resolve) => setImmediate(resolve));
		this.sliceStart = sliceClock();
	}
}

export async function mapInSlices<T, R>(
	items: readonly T[],
	transform: (item: T) => R,
	slicer: EventLoopSlicer,
): Promise<R[]> {
	const mapped: R[] = [];
	for (const item of items) {
		mapped.push(transform(item));
		if (slicer.due) await slicer.yield();
	}
	return mapped;
}
