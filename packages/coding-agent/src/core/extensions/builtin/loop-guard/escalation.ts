import type { LoopGuardDetection } from "./detectors.ts";
import { IDENTICAL_BLOCK_NOTICE_THRESHOLD, IDENTICAL_HARD_STOP_BLOCK_THRESHOLD } from "./policy.ts";
import type { ToolCallRecord } from "./tracker.ts";

export type IdenticalEscalationDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "block"; readonly toolName: string; readonly blockedCallCount: number; readonly windowed: boolean }
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

export class IdenticalLoopEscalation {
	private episode: IdenticalLoopEpisode | undefined;
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
				if (this.episode === undefined || this.episode.fingerprint !== detection.fingerprint) {
					this.episode = {
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
		if (attempt === undefined || this.episode === undefined || this.episode.fingerprint !== attempt.signature) {
			return ALLOW_DECISION;
		}
		if (!this.episode.blockActive) {
			if (this.episode.activateBlockAfterAttempt) {
				this.episode.activateBlockAfterAttempt = false;
				this.episode.blockActive = true;
			}
			return ALLOW_DECISION;
		}
		this.episode.blockedCallCount++;
		if (this.episode.blockedCallCount >= IDENTICAL_HARD_STOP_BLOCK_THRESHOLD) {
			const announce = !this.episode.hardStopAnnounced;
			this.episode.hardStopAnnounced = true;
			return {
				kind: "hardStop",
				toolName: this.episode.toolName,
				blockedCallCount: this.episode.blockedCallCount,
				announce,
				windowed: this.episode.windowed,
			};
		}
		return {
			kind: "block",
			toolName: this.episode.toolName,
			blockedCallCount: this.episode.blockedCallCount,
			windowed: this.episode.windowed,
		};
	}

	/** Drops the armed episode while keeping per-turn attempt correlation. */
	clearEpisode(): void {
		this.episode = undefined;
	}

	/** Fingerprint of an active windowed episode, for age-out checks against the tracker window. */
	get windowedEpisodeFingerprint(): string | undefined {
		return this.episode?.windowed ? this.episode.fingerprint : undefined;
	}

	reset(): void {
		this.episode = undefined;
		this.attempts.clear();
	}
}
