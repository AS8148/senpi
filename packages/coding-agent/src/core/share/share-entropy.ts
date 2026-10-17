/**
 * Generic secret detection for `/share` (#3524): values that match no known
 * provider shape but look machine-generated. Lowercase hex (commit ids,
 * digests), UUIDs and ULIDs never qualify, identifiers that read as words are
 * spared, and SRI integrity hashes stay. A token wrapped across a line break is
 * judged as one value.
 */

const RUN_CHAR = "[A-Za-z0-9+/=_-]";
const SINGLE_RUN = new RegExp(`(?<!${RUN_CHAR})${RUN_CHAR}{32,}(?!${RUN_CHAR})`, "g");
const SPLIT_RUN = new RegExp(`(?<!${RUN_CHAR})(${RUN_CHAR}{8,})(\\r?\\n[ \\t]*)(${RUN_CHAR}{8,})(?!${RUN_CHAR})`, "g");
const WRAPPED_TAIL = new RegExp(`(<redacted>)(\\r?\\n[ \\t]*)(${RUN_CHAR}{6,})(?!${RUN_CHAR})`, "g");
const INTEGRITY_PREFIX = /sha(?:256|384|512)-$/;
const INTEGRITY_RUN = /^sha(?:256|384|512)-/;
const WORD = /[A-Z]?[a-z]{3,}/g;

export function shannonBitsPerChar(text: string): number {
	const counts = new Map<string, number>();
	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
	return bits;
}

/** Identifiers are made of words: mostly word-shaped runs, with the vowel density of English (random letters have ~19%). */
function readsAsWords(run: string): boolean {
	const covered = [...run.matchAll(WORD)].reduce((sum, match) => sum + match[0].length, 0);
	const letters = run.replace(/[^A-Za-z]/g, "");
	const vowels = letters.replace(/[^aeiouAEIOU]/g, "").length;
	return covered >= run.length * 0.6 && letters.length > 0 && vowels / letters.length >= 0.3;
}

function readsAsPath(run: string): boolean {
	const segments = run.split("/").filter((segment) => segment.length > 0);
	return segments.length >= 2 && segments.every((segment) => /^[a-z0-9._@-]+$/.test(segment) || readsAsWords(segment));
}

/** Mixed case plus digits, high per-character entropy for its length, and not words or a path. */
export function looksGenerated(run: string): boolean {
	const body = run.replace(/=+$/, "");
	if (body.length < 16) return false;
	const digits = body.replace(/[^0-9]/g, "").length;
	const upper = body.replace(/[^A-Z]/g, "").length;
	const lower = body.replace(/[^a-z]/g, "").length;
	const base64Symbols = /[+/]/.test(body);
	if (upper < 2 || lower < 2 || (digits < 2 && !base64Symbols)) return false;
	if (shannonBitsPerChar(body) < Math.min(4.3, Math.log2(body.length) - 0.7)) return false;
	return !readsAsWords(body) && !readsAsPath(body);
}

export function redactGeneratedValues(text: string, onRedact: () => void): string {
	const redactUnlessIntegrity = (run: string, offset: number, whole: string): string => {
		if (INTEGRITY_RUN.test(run) || INTEGRITY_PREFIX.test(whole.slice(Math.max(0, offset - 7), offset))) return run;
		if (!looksGenerated(run)) return run;
		onRedact();
		return "<redacted>";
	};
	let result = text.replace(
		SPLIT_RUN,
		(match, head: string, gap: string, tail: string, offset: number, whole: string) => {
			if (INTEGRITY_RUN.test(head) || INTEGRITY_PREFIX.test(whole.slice(Math.max(0, offset - 7), offset)))
				return match;
			if (!looksGenerated(head + tail)) return match;
			onRedact();
			return `<redacted>${gap}<redacted>`;
		},
	);
	result = result.replace(SINGLE_RUN, redactUnlessIntegrity);
	return result.replace(WRAPPED_TAIL, (match, redacted: string, gap: string, tail: string) => {
		const mixed = /[A-Za-z]/.test(tail) && (/[0-9]/.test(tail) || (/[A-Z]/.test(tail) && /[a-z]/.test(tail)));
		if (!mixed || readsAsWords(tail)) return match;
		onRedact();
		return `${redacted}${gap}<redacted>`;
	});
}
