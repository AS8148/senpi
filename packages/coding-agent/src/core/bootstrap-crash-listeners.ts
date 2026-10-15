type CrashEvent = "uncaughtException" | "unhandledRejection";

const bootstrapListeners = new WeakSet<(...args: never[]) => unknown>();

/** Marks a process listener installed during bootstrap, before any mode registers its own crash handler. */
export function markBootstrapCrashListener(listener: (...args: never[]) => unknown): void {
	bootstrapListeners.add(listener);
}

/**
 * True when a mode (interactive) has registered its own handler for `event`. Bootstrap listeners never
 * count, so two of them cannot each defer to the other and leave a real crash running.
 */
export function hasModeCrashHandler(event: CrashEvent): boolean {
	return process.listeners(event).some((listener) => !bootstrapListeners.has(listener));
}
