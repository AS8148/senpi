import type { SupervisorActivity, SupervisorOwner } from "./host-lifecycle-activity.ts";

/**
 * The longest gap between two idle/owner checks (senpi#3747). An idle exit is due minutes after the last
 * client left, and the detach that starts that window refreshes the activity at once, so a 1 s tick only
 * woke every idle supervisor every second; the tick stays a quarter of the idle window when that is shorter.
 */
export const SUPERVISOR_TICK_MAX_MS = 5_000;

/** Idle and lifetime-owner checks share one ticker and never overlap owner probes. */
export function startSupervisorTicker(options: {
	readonly idleExitMs: number;
	readonly activity: SupervisorActivity;
	readonly owner: SupervisorOwner;
	readonly draining: () => boolean;
	readonly shuttingDown: () => boolean;
	readonly shutdown: (reason: string, exitCode: number) => Promise<never>;
}): () => void {
	const { activity, owner, draining, shuttingDown, shutdown } = options;
	const tickIntervalMs = Math.max(20, Math.min(SUPERVISOR_TICK_MAX_MS, options.idleExitMs / 4));
	let ownerCheck = false;
	const ticker = setInterval(() => {
		if (!draining() && activity.refresh() === "exit" && activity.clients.unclassifiedCount === 0)
			void shutdown("idle", 0);
		if (!ownerCheck && !shuttingDown() && !draining()) {
			ownerCheck = true;
			void owner
				.shouldExit(activity)
				.then((exit) => {
					if (exit && !shuttingDown() && !draining()) void shutdown("owner_gone", 0);
				})
				.finally(() => {
					ownerCheck = false;
				});
		}
	}, tickIntervalMs);
	return () => {
		clearInterval(ticker);
		owner.stop();
	};
}
