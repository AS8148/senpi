import { appendDebugLogEntry } from "./hidden-stdout-log.ts";
import { parseSettingsJson } from "./settings-json.ts";
import type { Settings, SettingsStorage } from "./settings-manager.ts";

export const STATE_KEYS: ReadonlySet<keyof Settings> = new Set([
	"tipsHistory",
	"changelogSeen",
	"lastChangelogVersion",
	"modelThinkingLevels",
	"modelLastOnThinkingLevels",
	"modelServiceTiers",
]);

/**
 * Move raw global bookkeeping only after its state write succeeds. Re-read both files under
 * their locks, preserving existing state keys and every unrelated config key's value/order.
 */
export function migrateSettingsState(storage: SettingsStorage): void {
	const withStateLock = storage.withStateLock?.bind(storage);
	if (!withStateLock) return;
	try {
		storage.withLock("global", (current) => {
			if (!current) return undefined;
			const raw = parseSettingsJson(current);
			if (![...STATE_KEYS].some((key) => Object.hasOwn(raw, key))) return undefined;
			withStateLock((stateContent) => {
				const state = stateContent ? parseSettingsJson(stateContent) : {};
				let changed = false;
				for (const key of STATE_KEYS) {
					if (Object.hasOwn(raw, key) && !Object.hasOwn(state, key)) {
						state[key] = raw[key];
						changed = true;
					}
				}
				return changed ? JSON.stringify(state, null, 2) : undefined;
			});
			for (const key of STATE_KEYS) delete raw[key];
			return JSON.stringify(raw, null, 2);
		});
	} catch (error) {
		const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
		try {
			appendDebugLogEntry("settings: could not migrate global state keys", detail);
		} catch {
			// Best-effort diagnostics must not prevent reading the legacy settings fallback.
		}
	}
}

/** Only the six bookkeeping keys overlay config; arbitrary state-file keys are never settings. */
export function readSettingsState(storage: SettingsStorage): Record<string, unknown> {
	const state: Record<string, unknown> = {};
	storage.withStateLock?.((current) => {
		const raw = current ? parseSettingsJson(current) : {};
		for (const key of STATE_KEYS) {
			if (Object.hasOwn(raw, key)) state[key] = raw[key];
		}
		return undefined;
	});
	return state;
}
