import { isOwnershipEntryType, ownershipOf, SessionMovedAwayError, type SessionOwnership } from "./ownership.ts";

interface EntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

/**
 * The session-manager write funnel asks this before every persisted write. It folds only the entries appended since
 * the last call (the funnel appends in place), and starts over when the entry array is replaced by a load or branch.
 */
export class SessionWriteGuard {
	private source: readonly EntryLike[] | undefined;
	private seen = 0;
	private verdict: SessionOwnership = { writable: true };

	assertWritable(entries: readonly EntryLike[], entry: EntryLike, sessionFile: string): void {
		const ownership = this.current(entries);
		if (ownership.writable || (entry.type === "custom" && isOwnershipEntryType(entry.customType))) return;
		throw new SessionMovedAwayError(sessionFile, ownership);
	}

	private current(entries: readonly EntryLike[]): SessionOwnership {
		if (entries !== this.source || entries.length < this.seen) {
			this.source = entries;
			this.seen = 0;
			this.verdict = { writable: true };
		}
		for (; this.seen < entries.length; this.seen += 1) {
			const entry = entries[this.seen];
			if (entry !== undefined) this.verdict = ownershipOf(entry) ?? this.verdict;
		}
		return this.verdict;
	}
}
