/**
 * Launch-day edit block. Fable 5.5 is UNRELEASED; these ids are provisional.
 * Confirm identity, optional snapshot and Claude Code floor from live evidence.
 * Prices, context/output limits and status/deprecation come ONLY from models.dev
 * during regeneration, never from a local guessed price card or catalog row.
 * Keep recommendations disabled unless the optional promotion commit is wanted.
 */
export const FABLE55_LAUNCH = {
	modelId: "claude-fable-5-5",
	mythosModelId: "claude-mythos-5-5",
	snapshotId: null as string | null,
	minimumClaudeCodeVersion: null as string | null,
	released: false,
	promoteDefaults: false,
	metadataSource: "models.dev",
} as const;

/** Carry the existing Fable/Mythos routing convention, including gateway spellings. */
export function isFable55ModelId(modelId: string): boolean {
	const normalized = modelId.toLowerCase().replace(/\s+/g, "-");
	return [FABLE55_LAUNCH.modelId, FABLE55_LAUNCH.mythosModelId, FABLE55_LAUNCH.snapshotId].some((id) => {
		if (!id) return false;
		const family = id.replace(/^claude-/, "");
		const dotted = family.replace(/-(\d+)-(\d+)$/, "-$1.$2");
		return [family, dotted].some((marker) => {
			const at = normalized.indexOf(marker);
			if (at < 0) return false;
			const before = normalized[at - 1];
			const after = normalized[at + marker.length];
			return (!before || /[/@:._-]/.test(before)) && (!after || /[/@:._-]/.test(after));
		});
	});
}
