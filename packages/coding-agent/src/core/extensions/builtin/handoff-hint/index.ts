import { type AnyModel, resolvePromptCacheTtlSeconds } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../../../session-manager.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "../../types.ts";
import { CACHE_WARM_PING_EVENT } from "../cache-keepalive/index.ts";
import { baseThresholdRatioForWindow } from "../compaction/policy.ts";
import { readGoal } from "../goal/store.ts";
import { goalStoreRef } from "../goal/store-ref.ts";
import type { Goal } from "../goal/types.ts";
import { buildHandoffBrief } from "./brief.ts";
import { estimateHandoff, type HandoffEstimate, hintText } from "./estimate.ts";

export const HANDOFF_HINT_ENTRY_TYPE = "handoff-hint";
export const HANDOFF_BRIEF_MESSAGE_TYPE = "handoff-brief";
export const HANDOFF_HINT_EVENT = "handoff_hint";
export const HANDOFF_HINT_WIDGET_KEY = "handoff-hint";
export const HANDOFF_COMMAND = "handoff";
export const START_FRESH_LABEL = "Start fresh with a handoff";
export const KEEP_GOING_LABEL = "Keep going";

export const DEFAULT_HANDOFF_HINT_SETTINGS = { enabled: true, minContextTokens: 200_000, minSavingUsd: 1 };

export type HandoffHintAction = "shown" | "accepted" | "dismissed";

export interface HandoffHintEvent {
	readonly action: HandoffHintAction;
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
	readonly contextTokens: number;
	readonly nextReplyUsd: number;
	readonly freshUsd: number;
	readonly savingUsd: number;
	readonly subscription: boolean;
}

interface DismissedEntry {
	readonly phase: "dismissed";
}

type HandoffHintSettings = typeof DEFAULT_HANDOFF_HINT_SETTINGS;

function settingsOf(pi: ExtensionAPI): HandoffHintSettings {
	const configured = pi.getSettings().handoffHint;
	return {
		enabled: configured?.enabled ?? DEFAULT_HANDOFF_HINT_SETTINGS.enabled,
		minContextTokens: configured?.minContextTokens ?? DEFAULT_HANDOFF_HINT_SETTINGS.minContextTokens,
		minSavingUsd: configured?.minSavingUsd ?? DEFAULT_HANDOFF_HINT_SETTINGS.minSavingUsd,
	};
}

function promptTokensOfFirstReply(entries: readonly SessionEntry[]): number | undefined {
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (tokens > 0) return tokens;
	}
	return undefined;
}

function wasDismissed(entries: readonly SessionEntry[]): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === HANDOFF_HINT_ENTRY_TYPE &&
			(entry.data as DismissedEntry | undefined)?.phase === "dismissed",
	);
}

type ActiveGoalReader = (ctx: ExtensionContext) => Promise<Goal | null>;

const readActiveGoal: ActiveGoalReader = (ctx) => readGoal(goalStoreRef(ctx.sessionManager, ctx.cwd)).catch(() => null);

export function createHandoffHintExtension(
	dependencies: { readonly now?: () => number; readonly readGoal?: ActiveGoalReader } = {},
): ExtensionFactory {
	const now = dependencies.now ?? Date.now;
	const goalOf = dependencies.readGoal ?? readActiveGoal;
	return (pi: ExtensionAPI) => {
		let ctx: ExtensionContext | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let lastRequestAtMs: number | undefined;
		let humanStartedTurn = false;
		let dismissed = false;
		let shownThisCrossing = false;
		let visible: HandoffEstimate | undefined;

		const worker = pi.sessionKind === "worker";

		function emit(action: HandoffHintAction, current: ExtensionContext, estimate: HandoffEstimate): void {
			const model = current.model;
			const event: HandoffHintEvent = {
				action,
				sessionId: current.sessionManager.getSessionId(),
				provider: model?.provider ?? "",
				model: model?.id ?? "",
				contextTokens: estimate.contextTokens,
				nextReplyUsd: estimate.nextReplyUsd,
				freshUsd: estimate.freshUsd,
				savingUsd: estimate.savingUsd,
				subscription: model !== undefined && current.modelRegistry.isUsingOAuth(model),
			};
			pi.events?.emit(HANDOFF_HINT_EVENT, event);
		}

		function disarm(): void {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		}

		function hide(current: ExtensionContext | undefined): void {
			if (visible === undefined) return;
			visible = undefined;
			current?.ui.setWidget(HANDOFF_HINT_WIDGET_KEY, undefined);
		}

		async function eligibleEstimate(current: ExtensionContext): Promise<HandoffEstimate | undefined> {
			const settings = settingsOf(pi);
			const model = current.model as AnyModel | undefined;
			if (!settings.enabled || dismissed || worker || !humanStartedTurn || model === undefined) return undefined;
			if (current.mode !== "tui" && current.mode !== "rpc") return undefined;
			if (!current.hasUI || !current.isIdle() || current.hasPendingMessages() || current.isCompacting?.())
				return undefined;
			const usage = current.getContextUsage();
			const tokens = usage?.tokens;
			if (usage === undefined || tokens === null || tokens === undefined) return undefined;
			if (tokens < settings.minContextTokens) {
				shownThisCrossing = false;
				return undefined;
			}
			if (shownThisCrossing) return undefined;
			if (
				usage.contextWindow > 0 &&
				tokens >= usage.contextWindow * baseThresholdRatioForWindow(usage.contextWindow)
			)
				return undefined;
			const goal = await goalOf(current);
			if (goal?.status === "active") return undefined;
			const fresh = promptTokensOfFirstReply(current.sessionManager.getFullBranch()) ?? tokens;
			const estimate = estimateHandoff(model, tokens, fresh, now());
			if (estimate === undefined || estimate.savingUsd < settings.minSavingUsd) return undefined;
			return estimate;
		}

		async function showIfDue(): Promise<void> {
			timer = undefined;
			const current = ctx;
			if (current === undefined || visible !== undefined) return;
			const estimate = await eligibleEstimate(current);
			if (estimate === undefined || ctx !== current || !current.isIdle()) return;
			const subscription = current.model !== undefined && current.modelRegistry.isUsingOAuth(current.model);
			visible = estimate;
			shownThisCrossing = true;
			current.ui.setWidget(HANDOFF_HINT_WIDGET_KEY, [hintText(estimate, subscription)], {
				placement: "aboveEditor",
				actions: [
					{ label: START_FRESH_LABEL, command: `/${HANDOFF_COMMAND}` },
					{ label: KEEP_GOING_LABEL, command: `/${HANDOFF_COMMAND} keep` },
				],
			});
			emit("shown", current, estimate);
		}

		function arm(): void {
			disarm();
			const current = ctx;
			const model = current?.model;
			if (current === undefined || model === undefined || lastRequestAtMs === undefined) return;
			if (dismissed || worker || !settingsOf(pi).enabled) return;
			const ttlSeconds = resolvePromptCacheTtlSeconds(model);
			if (ttlSeconds === undefined) return;
			const delayMs = Math.max(0, lastRequestAtMs + ttlSeconds * 1000 - now());
			timer = setTimeout(() => void showIfDue(), delayMs);
		}

		async function startFresh(current: ExtensionCommandContext): Promise<void> {
			const estimate = visible;
			const usage = current.getContextUsage();
			const goal = await goalOf(current);
			const brief = buildHandoffBrief({
				entries: current.sessionManager.getFullBranch(),
				goal,
				cwd: current.cwd,
				modelLabel: current.model ? `${current.model.provider}/${current.model.id}` : undefined,
				previousSessionFile: current.sessionManager.getSessionFile(),
				contextTokens: usage?.tokens ?? estimate?.contextTokens ?? 0,
			});
			hide(current);
			if (estimate !== undefined) emit("accepted", current, estimate);
			await current.newSession({
				parentSession: current.sessionManager.getSessionFile(),
				withSession: async (next) => {
					await next.sendMessage(
						{ customType: HANDOFF_BRIEF_MESSAGE_TYPE, content: brief, display: true },
						{ triggerTurn: false },
					);
				},
			});
		}

		pi.registerCommand(HANDOFF_COMMAND, {
			description: "Start a fresh session seeded with a short handoff brief (`/handoff keep` hides the hint)",
			argumentHint: "[keep]",
			handler: async (args, current) => {
				if (args.trim() === "keep") {
					const estimate = visible;
					dismissed = true;
					disarm();
					hide(current);
					pi.appendEntry<DismissedEntry>(HANDOFF_HINT_ENTRY_TYPE, { phase: "dismissed" });
					if (estimate !== undefined) emit("dismissed", current, estimate);
					return;
				}
				await startFresh(current);
			},
		});

		pi.on("session_start", (_event, next) => {
			ctx = next;
			disarm();
			visible = undefined;
			shownThisCrossing = false;
			humanStartedTurn = false;
			lastRequestAtMs = undefined;
			dismissed = wasDismissed(next.sessionManager.getFullBranch());
		});
		pi.on("input", (event) => {
			humanStartedTurn = event.source !== "extension";
			disarm();
			hide(ctx);
			return { action: "continue" };
		});
		pi.on("agent_start", () => {
			disarm();
			hide(ctx);
		});
		pi.on("agent_end", (_event, next) => {
			ctx = next;
			lastRequestAtMs = now();
		});
		pi.on("agent_settled", (_event, next) => {
			ctx = next;
			arm();
		});
		pi.on("session_compact", () => {
			hide(ctx);
			arm();
		});
		pi.on("model_select", (_event, next) => {
			ctx = next;
			arm();
		});
		pi.events?.on(CACHE_WARM_PING_EVENT, () => {
			lastRequestAtMs = now();
			if (timer !== undefined) arm();
		});
		pi.on("session_shutdown", () => {
			disarm();
			ctx = undefined;
		});
	};
}

export default createHandoffHintExtension();
