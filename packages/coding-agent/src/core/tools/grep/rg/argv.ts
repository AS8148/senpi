/**
 * Characters one rg command line may use. Windows caps a whole command line at
 * 32,767 characters; POSIX shares ARG_MAX (1 MiB on macOS) with the environment.
 * Batches split to stay under it and never truncate an argument.
 */
export function argvBudget(platform: NodeJS.Platform = process.platform): number {
	return platform === "win32" ? 32_000 : 256 * 1024;
}

/** Room kept for the executable path, which the command line carries but the argument list does not. */
export const EXECUTABLE_RESERVE = 4096;

/**
 * Characters one argument occupies on the command line: its separator and, on Windows,
 * the surrounding quotes plus the backslash escapes libuv adds before quotes and trailing backslashes.
 */
export function argvCost(argument: string, platform: NodeJS.Platform = process.platform): number {
	if (platform !== "win32") return argument.length + 1;
	const quotes = argument.match(/"/g)?.length ?? 0;
	const doubled = argument.match(/\\+(?="|$)/g)?.join("").length ?? 0;
	return argument.length + 3 + quotes + doubled;
}

/** Room left for per-file arguments once a launch's fixed arguments are counted. */
export function roomAfter(
	fixed: readonly string[],
	budget: number,
	platform: NodeJS.Platform = process.platform,
): number {
	return budget - EXECUTABLE_RESERVE - fixed.reduce((sum, argument) => sum + argvCost(argument, platform), 0);
}

/** Splits items into ordered batches whose cost fits the room; an oversized single item still gets its own batch. */
export function packArgv<T>(items: readonly T[], costOf: (item: T) => number, room: number): T[][] {
	const batches: T[][] = [];
	let used = 0;
	for (const item of items) {
		const cost = costOf(item);
		const batch = batches.at(-1);
		if (batch && used + cost <= room) {
			batch.push(item);
			used += cost;
		} else {
			batches.push([item]);
			used = cost;
		}
	}
	return batches;
}
