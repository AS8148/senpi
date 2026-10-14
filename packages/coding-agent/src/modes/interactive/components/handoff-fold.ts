/**
 * Finds the handoff block (`Ask: ... - wanted: ... For you: ... Now: ... Next: ...`, or the GPT
 * presets' `... You need: ... Now: ... Next: ...`) in an assistant text so the transcript can fold
 * its bookkeeping into one muted line (senpi#3323). The labels stay English by prompt contract
 * (`HANDOFF_LANGUAGE_RULE`), so they are matched literally; the slot contents are any language.
 */

export type TextSegment = { readonly kind: "text"; readonly text: string };

export type HandoffSegment = {
	readonly kind: "handoff";
	/** The block exactly as written, shown when the fold is open. */
	readonly block: string;
	/** The `For you:` / `You need:` slot: what the reader needs, kept in the transcript as answer text. */
	readonly forYou: string | undefined;
	readonly now: string | undefined;
	readonly next: string | undefined;
};

export type AssistantTextSegment = TextSegment | HandoffSegment;

const LABEL = /(?:\*{1,2})?\b(Ask|wanted|For you|You need|Now|Next)(?:\*{1,2})?\s*[:\uFF1A](?:\*{1,2})?/gu;
const OPENING_LABELS = new Set(["Ask", "wanted", "For you", "You need"]);

type LabelHit = { readonly label: string; readonly start: number; readonly end: number };

function labelsOf(paragraph: string): LabelHit[] {
	return [...paragraph.matchAll(LABEL)].map((match) => ({
		label: match[1] ?? "",
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length,
	}));
}

function slot(paragraph: string, hits: readonly LabelHit[], label: string): string | undefined {
	const at = hits.findIndex((hit) => hit.label === label);
	if (at < 0) return undefined;
	const start = hits[at]?.end ?? 0;
	const end = hits[at + 1]?.start ?? paragraph.length;
	const text = paragraph
		.slice(start, end)
		.trim()
		.replace(/^[-\s]+|[-\s]+$/gu, "")
		.trim();
	return text === "" ? undefined : text;
}

function parseHandoff(paragraph: string): HandoffSegment | undefined {
	const hits = labelsOf(paragraph);
	const labels = new Set(hits.map((hit) => hit.label));
	if (!labels.has("Now") || !labels.has("Next")) return undefined;
	if (![...labels].some((label) => OPENING_LABELS.has(label))) return undefined;
	return {
		kind: "handoff",
		block: paragraph,
		forYou: slot(paragraph, hits, "For you") ?? slot(paragraph, hits, "You need"),
		now: slot(paragraph, hits, "Now"),
		next: slot(paragraph, hits, "Next"),
	};
}

/**
 * Splits an assistant text into prose and handoff blocks. A block is one paragraph (blank-line
 * separated) carrying `Now:` and `Next:` plus an opening label; a paragraph inside a code fence never
 * counts. Text with no block comes back as one text segment.
 */
export function splitHandoffBlocks(text: string): readonly AssistantTextSegment[] {
	const paragraphs = text.split(/\n[ \t]*\n/u);
	const segments: AssistantTextSegment[] = [];
	let prose: string[] = [];
	let inFence = false;
	const flush = () => {
		const joined = prose.join("\n\n").trim();
		if (joined !== "") segments.push({ kind: "text", text: joined });
		prose = [];
	};
	for (const paragraph of paragraphs) {
		const fences = paragraph.match(/^\s*(?:```|~~~)/gmu)?.length ?? 0;
		const handoff = !inFence && fences === 0 ? parseHandoff(paragraph.trim()) : undefined;
		if (fences % 2 === 1) inFence = !inFence;
		if (!handoff) {
			prose.push(paragraph);
			continue;
		}
		flush();
		segments.push(handoff);
	}
	flush();
	return segments;
}
