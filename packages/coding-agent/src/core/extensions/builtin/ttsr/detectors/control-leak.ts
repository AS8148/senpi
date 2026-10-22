import { isAsciiWhitespace, ScalarScanner } from "../stream-utils.ts";
import type { DetectorContext, DetectorMatch, StreamDetector } from "../types.ts";
import { type LeakContextKind, StreamContextTracker } from "./leak-context.ts";
import { CandidateParser, type ControlToken, type TokenFamily } from "./token-grammar.ts";

export type { LeakContextKind } from "./leak-context.ts";

const MAX_RUN_GAP_WHITESPACE = 32;
const GAP_TRACK_CAP = 33;
const RUN_THRESHOLD_START = 3;
const RUN_THRESHOLD_NORMAL = 4;
const RUN_THRESHOLD_QUOTATION = 8;
const EVIDENCE_TTL_CHARS = 2048;
const NO_PAYLOAD_OFFSET = -1;

export interface PendingControlEvidence {
	readonly tokenId: string;
	readonly family: TokenFamily;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly quotationLike: boolean;
	readonly gapLength: number;
	readonly firstPayloadOffset: number;
	readonly expiresAtOffset: number;
}

interface TokenRun {
	readonly tokenId: string;
	readonly family: TokenFamily;
	readonly context: LeakContextKind;
	readonly firstStartOffset: number;
	count: number;
}

export interface ControlLeakState {
	scanner: ScalarScanner;
	parser: CandidateParser;
	tracker: StreamContextTracker;
	run: TokenRun | null;
	whitespaceOnlySinceToken: boolean;
	whitespaceSinceToken: number;
	pendingEvidence: PendingControlEvidence | undefined;
	latched: DetectorMatch | null;
	currentOffset: number;
}

function thresholdFor(context: LeakContextKind): number {
	if (context === "start") {
		return RUN_THRESHOLD_START;
	}
	if (context === "quotation") {
		return RUN_THRESHOLD_QUOTATION;
	}
	return RUN_THRESHOLD_NORMAL;
}

function noteNonWhitespace(state: ControlLeakState, offset: number): void {
	const evidence = state.pendingEvidence;
	if (evidence !== undefined && evidence.firstPayloadOffset === NO_PAYLOAD_OFFSET) {
		state.pendingEvidence = {
			...evidence,
			gapLength: state.whitespaceSinceToken,
			firstPayloadOffset: offset,
		};
	}
}

function processGround(state: ControlLeakState, value: string, offset: number): void {
	if (value.length === 1 && isAsciiWhitespace(value.charCodeAt(0))) {
		if (state.whitespaceSinceToken < GAP_TRACK_CAP) {
			state.whitespaceSinceToken += 1;
		}
	} else {
		state.whitespaceOnlySinceToken = false;
		noteNonWhitespace(state, offset);
	}
	state.tracker.observeGround(value);
}

function processReject(state: ControlLeakState, text: string, startOffset: number): void {
	state.whitespaceOnlySinceToken = false;
	noteNonWhitespace(state, startOffset);
	state.tracker.observeText(text);
}

function processToken(state: ControlLeakState, token: ControlToken): void {
	const context = state.tracker.classify(token.startOffset);
	noteNonWhitespace(state, token.startOffset);
	const run = state.run;
	if (
		run !== null &&
		run.tokenId === token.tokenId &&
		state.whitespaceOnlySinceToken &&
		state.whitespaceSinceToken <= MAX_RUN_GAP_WHITESPACE
	) {
		run.count += 1;
	} else {
		state.run = {
			tokenId: token.tokenId,
			family: token.family,
			context,
			firstStartOffset: token.startOffset,
			count: 1,
		};
	}
	state.pendingEvidence = {
		tokenId: token.tokenId,
		family: token.family,
		startOffset: token.startOffset,
		endOffset: token.endOffset,
		quotationLike: context === "quotation",
		gapLength: 0,
		firstPayloadOffset: NO_PAYLOAD_OFFSET,
		expiresAtOffset: token.endOffset + EVIDENCE_TTL_CHARS,
	};
	state.whitespaceSinceToken = 0;
	state.whitespaceOnlySinceToken = true;
	state.tracker.observeText(token.text);
	const active = state.run;
	if (active !== null && active.count >= thresholdFor(active.context)) {
		state.latched = {
			rule: "control-token-leak",
			reason: `${active.count}x ${active.tokenId} run in ${active.context} context`,
			anomalyStartOffset: active.firstStartOffset,
			garbageStartOffset: active.firstStartOffset,
			detail: {
				tokenId: active.tokenId,
				family: active.family,
				occurrences: active.count,
				context: active.context,
			},
		};
	}
}

export function corroboratesControlLeak(
	evidence: PendingControlEvidence,
	collapseMatchAnomalyStartOffset: number,
	currentOffset: number,
): boolean {
	if (currentOffset > evidence.expiresAtOffset) {
		return false;
	}
	if (evidence.firstPayloadOffset === NO_PAYLOAD_OFFSET) {
		return false;
	}
	if (evidence.gapLength > MAX_RUN_GAP_WHITESPACE) {
		return false;
	}
	return evidence.firstPayloadOffset === collapseMatchAnomalyStartOffset;
}

export function createControlLeakDetector(): StreamDetector<ControlLeakState> {
	return {
		createState: () => ({
			scanner: new ScalarScanner(),
			parser: new CandidateParser(),
			tracker: new StreamContextTracker(),
			run: null,
			whitespaceOnlySinceToken: true,
			whitespaceSinceToken: 0,
			pendingEvidence: undefined,
			latched: null,
			currentOffset: 0,
		}),
		checkDelta: (state: ControlLeakState, delta: string, ctx: DetectorContext) => {
			if (state.latched !== null) {
				return state.latched;
			}
			for (const entry of state.scanner.push(delta)) {
				for (const outcome of state.parser.feed(entry.value, entry.startOffset)) {
					if (outcome.kind === "ground") {
						processGround(state, outcome.value, outcome.offset);
					} else if (outcome.kind === "reject") {
						processReject(state, outcome.text, outcome.startOffset);
					} else {
						// Tool arguments carry markup (HTML for show_html_page, XML, JSX), so an angle-bracket
						// tag there is payload, not a leaked token. `<|...|>` and `[UPPER]` leaks still count
						// because they would be written to disk by the tool (omo#10789).
						if (ctx.source === "tool" && outcome.token.family === "sgml") {
							processReject(state, outcome.token.text, outcome.token.startOffset);
						} else {
							processToken(state, outcome.token);
						}
					}
				}
				if (state.latched !== null) {
					break;
				}
			}
			state.currentOffset = state.scanner.offset;
			return state.latched;
		},
		flush: (state: ControlLeakState) => state.latched,
	};
}
