import type { LoopGuardDetection } from "./detectors.ts";
import { IDENTICAL_BLOCK_NOTICE_THRESHOLD, IDENTICAL_HARD_STOP_BLOCK_THRESHOLD } from "./policy.ts";
import type { ToolCallRecord } from "./tracker.ts";

export type IdenticalEscalationDecision =
	| { readonly kind: "allow" }
	| {
			readonly kind: "block";
			readonly toolName: string;
			readonly blockedCallCount: number;
			readonly windowed: boolean;
	  }
	| {
			readonly kind: "hardStop";
			readonly toolName: string;
			readonly blockedCallCount: number;
			readonly announce: boolean;
			readonly windowed: boolean;
	  };

interface IdenticalLoopEpisode {
	fingerprint: string;
	toolName: string;
	windowed: boolean;
	admittedNoticeCount: number;
	activateBlockAfterAttempt: boolean;
	blockActive: boolean;
	blockedCallCount: number;
	hardStopAnnounced: boolean;
}

const ALLOW_DECISION = { kind: "allow" } as const;

function newEpisode(detection: { fingerprint: string; toolName: string; windowed: boolean }): IdenticalLoopEpisode {
	return {
		fingerprint: detection.fingerprint,
		toolName: detection.toolName,
		windowed: detection.windowed,
		admittedNoticeCount: 0,
		activateBlockAfterAttempt: false,
		blockActive: false,
		blockedCallCount: 0,
		hardStopAnnounced: false,
	};
}

export class IdenticalLoopEscalation {
	/** Consecutive-run episode; a different-signature call ends it. */
	private episode: IdenticalLoopEpisode | undefined;
	/** Windowed episodes keyed by fingerprint, so interleaved loops escalate independently. */
	private readonly windowedEpisodes = new Map<string, IdenticalLoopEpisode>();
	private readonly attempts = new Map<string, ToolCallRecord>();

	observeAttempt(toolCallId: string, record: ToolCallRecord): boolean {
		// Windowed episodes are armed by non-consecutive repeats, so a different-signature
		// call between repeats is the pattern itself, not a break from it.
		const patternChanged =
			this.episode !== undefined && !this.episode.windowed && this.episode.fingerprint !== record.signature;
		if (patternChanged) {
			this.reset();
		}
		this.attempts.set(toolCallId, record);
		return patternChanged;
	}

	observeNotice(detection: LoopGuardDetection): void {
		switch (detection.kind) {
			case "similar":
			case "cycle":
				return;
			case "identical": {
				if (detection.windowed) {
					const windowed = this.windowedEpisodes.get(detection.fingerprint) ?? newEpisode(detection);
					this.windowedEpisodes.set(detection.fingerprint, windowed);
					windowed.admittedNoticeCount++;
					if (windowed.admittedNoticeCount >= IDENTICAL_BLOCK_NOTICE_THRESHOLD) {
						windowed.activateBlockAfterAttempt = true;
					}
					return;
				}
				if (this.episode === undefined || this.episode.fingerprint !== detection.fingerprint) {
					this.episode = newEpisode(detection);
				}
				this.episode.admittedNoticeCount++;
				if (this.episode.admittedNoticeCount >= IDENTICAL_BLOCK_NOTICE_THRESHOLD) {
					this.episode.activateBlockAfterAttempt = true;
				}
			}
		}
	}

	finishTurn(): void {
		this.attempts.clear();
	}

	consumeToolCall(toolCallId: string): IdenticalEscalationDecision {
		const attempt = this.attempts.get(toolCallId);
		this.attempts.delete(toolCallId);
		if (attempt === undefined) return ALLOW_DECISION;
		const windowed = this.windowedEpisodes.get(attempt.signature);
		const episode = windowed ?? (this.episode?.fingerprint === attempt.signature ? this.episode : undefined);
		if (episode === undefined) return ALLOW_DECISION;
		if (!episode.blockActive) {
			if (episode.activateBlockAfterAttempt) {
				episode.activateBlockAfterAttempt = false;
				episode.blockActive = true;
			}
			return ALLOW_DECISION;
		}
		episode.blockedCallCount++;
		if (episode.blockedCallCount >= IDENTICAL_HARD_STOP_BLOCK_THRESHOLD) {
			const announce = !episode.hardStopAnnounced;
			episode.hardStopAnnounced = true;
			return {
				kind: "hardStop",
				toolName: episode.toolName,
				blockedCallCount: episode.blockedCallCount,
				announce,
				windowed: episode.windowed,
			};
		}
		return {
			kind: "block",
			toolName: episode.toolName,
			blockedCallCount: episode.blockedCallCount,
			windowed: episode.windowed,
		};
	}

	/** Drops the consecutive episode while keeping per-turn attempt correlation. */
	clearEpisode(): void {
		this.episode = undefined;
	}

	/** Drops one windowed episode (age-out); true when no windowed episode remains. */
	clearWindowedEpisode(fingerprint: string): boolean {
		this.windowedEpisodes.delete(fingerprint);
		return this.windowedEpisodes.size === 0;
	}

	/** Fingerprints of active windowed episodes, for age-out checks against the tracker window. */
	get windowedEpisodeFingerprints(): ReadonlySet<string> {
		return this.windowedEpisodes.keys() as ReadonlySet<string>;
	}

	reset(): void {
		this.episode = undefined;
		this.windowedEpisodes.clear();
		this.attempts.clear();
	}
}
