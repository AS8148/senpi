/**
 * Whether this platform can read a process start time at all. On Windows every engine host records
 * `processStartTime: null` (measured on a Windows runner), so a generation-bound stop there binds
 * pid + instance id + generation instead (omo-desktop-app#3561).
 */
export function processStartTimeIsUnreadable(): boolean {
	return process.platform === "win32";
}
