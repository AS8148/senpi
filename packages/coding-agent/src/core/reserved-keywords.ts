/**
 * OmO's reserved prompt keywords (`ulw`, `mass ulw`, `ulw plan`, `ulw loop`, `ulw research`).
 *
 * Ported from the OmO desktop app's `findOmoReservedKeywordSpans`
 * (omo-desktop-app `packages/shared/src/model.ts`), which mirrors the engine's
 * skill-pointer detection: `\b` word boundaries, case-insensitive, spaces or
 * hyphens between words, and the mass aliases (`mulw`, `meth`, `ulw mass`).
 * Overlapping mentions all match ("ulw research" is both `ultrawork` and
 * `ulw-research`), and nothing inside injected blocks or fenced/inline code counts.
 */
export type ReservedKeyword = "ultrawork" | "mass-ulw" | "ulw-plan" | "ulw-loop" | "ulw-research";

export interface ReservedKeywordSpan {
	readonly keyword: ReservedKeyword;
	/** UTF-16 offsets into the searched text, end exclusive. */
	readonly start: number;
	readonly end: number;
}

export interface ReservedKeywordRun {
	readonly start: number;
	readonly end: number;
}

const MASS_ULW_ALIAS = String.raw`(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)`;

const RESERVED_KEYWORD_PATTERNS: ReadonlyArray<readonly [ReservedKeyword, RegExp]> = [
	["ultrawork", /\b(?:ultrawork|ulw)\b/gi],
	["mass-ulw", new RegExp(String.raw`\b${MASS_ULW_ALIAS}\b`, "gi")],
	["ulw-plan", /\bulw[\s-]*plan\b/gi],
	["ulw-loop", /\bulw[\s-]*loop\b/gi],
	["ulw-research", new RegExp(String.raw`\b(?:ulw|${MASS_ULW_ALIAS})[\s-]*research\b`, "gi")],
];

/** Cheap pre-check: every reserved keyword contains one of these stems. */
const RESERVED_KEYWORD_STEM = /ulw|ultrawork|mulw|meth/i;

const INJECTED_BLOCK = /<(omo-[a-z0-9-]+-pointer|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

function maskRegion(region: string): string {
	return region.replace(/[^\r\n]/g, "\0");
}

/** Injected blocks, fenced code and inline code are quoted material, never a request. */
function maskQuotedRegions(text: string): string {
	let visible = text.replace(INJECTED_BLOCK, maskRegion);
	const fenceStart = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
	for (let opening = fenceStart.exec(visible); opening !== null; opening = fenceStart.exec(visible)) {
		const fence = opening[1] ?? "```";
		const fenceEnd = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, "gm");
		fenceEnd.lastIndex = fenceStart.lastIndex;
		const closing = fenceEnd.exec(visible);
		const end = closing === null ? visible.length : fenceEnd.lastIndex;
		visible = visible.slice(0, opening.index) + maskRegion(visible.slice(opening.index, end)) + visible.slice(end);
		fenceStart.lastIndex = end;
	}
	return visible.replace(INLINE_CODE, maskRegion);
}

/** Every reserved-keyword mention outside quoted regions, in text order. */
export function findReservedKeywordSpans(text: string): ReservedKeywordSpan[] {
	if (!RESERVED_KEYWORD_STEM.test(text)) return [];
	const visible = maskQuotedRegions(text);
	const spans: ReservedKeywordSpan[] = [];
	for (const [keyword, pattern] of RESERVED_KEYWORD_PATTERNS) {
		for (const match of visible.matchAll(pattern)) {
			spans.push({ keyword, start: match.index, end: match.index + match[0].length });
		}
	}
	return spans.sort((left, right) => left.start - right.start || right.end - left.end);
}

/** Overlapping mentions ("mass ulw research" is three) merge into one painted run, as on the desktop. */
export function findReservedKeywordRuns(text: string): ReservedKeywordRun[] {
	const runs: { start: number; end: number }[] = [];
	for (const span of findReservedKeywordSpans(text)) {
		const previous = runs.at(-1);
		if (previous !== undefined && span.start <= previous.end) {
			previous.end = Math.max(previous.end, span.end);
		} else {
			runs.push({ start: span.start, end: span.end });
		}
	}
	return runs;
}
