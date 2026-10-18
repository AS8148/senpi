/**
 * Who may write a session file when sessions move between devices (sisyphuslabs/omo-desktop-app#3137,
 * senpi#3630). The file itself records ownership: the LAST ownership entry decides. Entries that grant
 * this device ownership: none at all (a new session), a `takeover` release (the next local writer
 * continues), `session_moved_in` and `session_reclaimed`. Entries that refuse writes: a `move` release
 * (the session is on its way to another device) and `session_moved` (it arrived there).
 */

/** `customType` of the release entry; shared with `release_session` (`modes/rpc/session-release.ts`). */
export const SESSION_RELEASED = "session_released";
export const SESSION_MOVED_IN = "session_moved_in";
export const SESSION_MOVED = "session_moved";
export const SESSION_RECLAIMED = "session_reclaimed";

export type MoveId = string & { readonly __brand: "MoveId" };

export type SessionOwnership =
	| { readonly writable: true }
	| { readonly writable: false; readonly state: "moving"; readonly moveId: MoveId; readonly target: string }
	| { readonly writable: false; readonly state: "moved"; readonly moveId: MoveId; readonly target: string };

interface CustomLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
}

const OWNERSHIP_TYPES: ReadonlySet<string> = new Set([
	SESSION_RELEASED,
	SESSION_MOVED_IN,
	SESSION_MOVED,
	SESSION_RECLAIMED,
]);

/** Whether `customType` is one of the entries this module reads; those stay writable on a refused file. */
export function isOwnershipEntryType(customType: string | undefined): boolean {
	return customType !== undefined && OWNERSHIP_TYPES.has(customType);
}

function field(data: unknown, key: string): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

export function ownershipOf(entry: CustomLike): SessionOwnership | undefined {
	if (entry.type !== "custom" || !isOwnershipEntryType(entry.customType)) return undefined;
	const moveId = (field(entry.data, "move_id") ?? "") as MoveId;
	const target = field(entry.data, "target") ?? "";
	switch (entry.customType) {
		case SESSION_RELEASED:
			return field(entry.data, "reason") === "move" ? { writable: false, state: "moving", moveId, target } : { writable: true };
		case SESSION_MOVED:
			return { writable: false, state: "moved", moveId, target };
		case SESSION_MOVED_IN:
		case SESSION_RECLAIMED:
			return { writable: true };
		default:
			return undefined;
	}
}

export function sessionOwnership(entries: Iterable<CustomLike>): SessionOwnership {
	let verdict: SessionOwnership = { writable: true };
	for (const entry of entries) verdict = ownershipOf(entry) ?? verdict;
	return verdict;
}

export class SessionMovedAwayError extends Error {
	readonly code = "session_moved_away";
	readonly ownership: Exclude<SessionOwnership, { writable: true }>;

	constructor(sessionFile: string, ownership: Exclude<SessionOwnership, { writable: true }>) {
		const where = ownership.target === "" ? "another device" : ownership.target;
		super(
			ownership.state === "moving"
				? `This session is being moved to ${where}; it is read-only here. Wait for the move to finish, or make a copy to keep working here. (${sessionFile})`
				: `This session was moved to ${where}; it is read-only here. Open it on ${where}, or make a copy here. (${sessionFile})`,
		);
		this.name = "SessionMovedAwayError";
		this.ownership = ownership;
	}
}
