import { appendDebugLogEntry } from "../hidden-stdout-log.ts";
import { CredentialStoreBusyError } from "../lockfile-policy.ts";

/**
 * Runs a pool health write that must never decide the request's outcome
 * (senpi#3285). Health is advisory: when the state file stays locked past its
 * bound, the write is skipped and logged, and the request carries on. A lost
 * success marker or block costs at most one extra failover attempt later.
 * Every other failure still propagates.
 */
export async function writeHealthUnlessStoreBusy<T>(
	what: string,
	write: () => Promise<T>,
): Promise<T | typeof STORE_BUSY> {
	try {
		return await write();
	} catch (error) {
		if (!(error instanceof CredentialStoreBusyError)) throw error;
		appendDebugLogEntry(
			"credential pool: skipped a health write, state file busy",
			`${what}: lock ${error.path} still held after ${error.waitedMs}ms`,
		);
		return STORE_BUSY;
	}
}

export const STORE_BUSY = Symbol("credential-pool-store-busy");
