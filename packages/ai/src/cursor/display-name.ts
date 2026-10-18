/** Cursor display-name cleanup for catalog identities (senpi#3620). */

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g;
const LEVEL_WORDS = /\s+(Minimal|Low|Medium|High|Extra High|XHigh|Max|None)\b/g;
const NO_ZDR_MARK = "\u0001";

export interface CursorNamedMember {
	readonly raw: { readonly name: string };
	readonly level: string | undefined;
}

/** Drops zero-width characters and collapses whitespace in a raw Cursor label. */
export function sanitizeCursorDisplayName(name: string): string {
	return name.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
}

/**
 * Names a grouped identity after its representative variant, without the level, fast and
 * thinking words that the identity's level map and thinking flag now carry. Cursor labels
 * the Haiku 5.5 split the other way round ("No Thinking" on the plain variants, nothing on
 * the thinking ones), so the plain group drops "No Thinking" whole and a thinking group
 * whose label never said so gains "Thinking".
 */
export function cleanCursorGroupName(
	members: readonly CursorNamedMember[],
	baseId: string,
	thinkingMode: boolean | undefined,
): string {
	const representative =
		members.find((member) => member.level === "high") ??
		members.find((member) => member.level === "medium") ??
		members.find((member) => member.level === "low") ??
		members[0];
	let name = sanitizeCursorDisplayName(representative.raw.name);
	name = name.replace(/\s*\(NO ZDR\)\s*/g, ` ${NO_ZDR_MARK}`).trim();
	name = name.replace(LEVEL_WORDS, "");
	name = name.replace(/\s+Fast\b/g, "");
	if (thinkingMode !== true) {
		name = name.replace(/\s+No Thinking\b/g, "").replace(/\s+Thinking\b/g, "");
	} else if (!/\bThinking\b/.test(name)) {
		name = name.includes(NO_ZDR_MARK)
			? name.replace(` ${NO_ZDR_MARK}`, ` Thinking ${NO_ZDR_MARK}`)
			: `${name} Thinking`;
	}
	name = sanitizeCursorDisplayName(name.replaceAll(NO_ZDR_MARK, "(NO ZDR)"));
	return name.length === 0 ? baseId : name;
}
