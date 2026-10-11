/** Session-local activity channel; lifecycle events never publish on it. */
export const USER_ACTIVITY_EVENT = "user_activity";

export type UserActivityKind = "draft" | "prompt";

export function emitUserActivity(
	session: { emitExtensionEvent(channel: string, data: unknown): void },
	kind: UserActivityKind,
): void {
	session.emitExtensionEvent(USER_ACTIVITY_EVENT, { kind });
}
