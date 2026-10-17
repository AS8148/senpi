/**
 * Characters one rg launch may spend on per-file arguments. Windows caps a whole
 * command line at 32,767 characters; POSIX shares ARG_MAX (1 MiB on macOS) with
 * the environment. Batches split at this budget and never truncate an argument.
 */
export function argvBudget(platform: NodeJS.Platform = process.platform): number {
	return platform === "win32" ? 24_000 : 256 * 1024;
}

/** Splits items into ordered batches whose argument cost fits the budget; an oversized single item still gets its own batch. */
export function packArgv<T>(items: readonly T[], costOf: (item: T) => number, budget: number): T[][] {
	const batches: T[][] = [];
	let used = 0;
	for (const item of items) {
		const cost = costOf(item);
		const batch = batches.at(-1);
		if (batch && used + cost <= budget) {
			batch.push(item);
			used += cost;
		} else {
			batches.push([item]);
			used = cost;
		}
	}
	return batches;
}
