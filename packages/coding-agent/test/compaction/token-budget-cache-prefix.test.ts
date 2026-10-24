import { describe, expect, it, vi } from "vitest";
import { buildAnthropicWarmPromptCacheParams } from "../../../ai/src/api/anthropic-messages.ts";
import { getBuiltinModel } from "../../../ai/src/providers/all.ts";
import { DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "../../src/core/extensions/index.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

type Handler = (
	event: BeforeAgentStartEvent,
	ctx: ExtensionContext,
) => Promise<BeforeAgentStartEventResult | undefined> | BeforeAgentStartEventResult | undefined;

function harness(restore: boolean) {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "synthetic request", timestamp: 1 });
	if (restore) {
		manager.appendCustomEntry("compaction.agent-checkpoint", {
			schema: "senpi.compaction.agent-checkpoint.v1",
			data: { activeTools: [], thinkingLevel: null, timestamp: Date.now() - 1000 },
		});
	}
	let handler: Handler | undefined;
	compactionExtension(
		Object.assign(Object.create(null), {
			on: (event: string, callback: unknown) => {
				if (event === "before_agent_start") handler = callback as Handler;
			},
			appendEntry: vi.fn(),
			getActiveTools: () => [],
			getAllTools: () => [],
			getThinkingLevel: () => "off",
			events: { emit: vi.fn() },
			sendMessage: vi.fn(),
		}) as ExtensionAPI,
	);
	let tokens = 750_000;
	const ctx = {
		hasUI: false,
		mode: "tui",
		ui: { notify: vi.fn() },
		sessionManager: manager,
		modelRegistry: {},
		isIdle: () => true,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }),
		getCompactionSettings: () => ({ ...DEFAULT_COMPACTION_SETTINGS, speculativeEnabled: false }),
		getMessageRevision: () => 1,
		beginCompaction: () => undefined,
		getSystemPrompt: () => "fixed synthetic system",
	} as unknown as ExtensionContext;
	const request = async () => {
		if (!handler) throw new Error("missing before_agent_start handler");
		const result = await handler(
			{
				type: "before_agent_start",
				prompt: "",
				systemPrompt: "fixed synthetic system",
				systemPromptOptions: { cwd: process.cwd() },
			} as BeforeAgentStartEvent,
			ctx,
		);
		if (result?.message) {
			const { customType, content, display, details } = result.message;
			manager.appendCustomMessageEntry(customType, content, display, details);
		}
		const model = getBuiltinModel("anthropic", "claude-opus-5-5");
		if (!model) throw new Error("missing synthetic model");
		return {
			result,
			payload: buildAnthropicWarmPromptCacheParams(
				model,
				{
					systemPrompt: result?.systemPrompt ?? "fixed synthetic system",
					messages: convertToLlm(manager.buildSessionContext().messages),
				},
				{ cacheRetention: "short" },
			),
		};
	};
	return {
		manager,
		request,
		changeBudget: () => {
			tokens += 5000;
		},
	};
}

describe("persisted late token budget reminder cache prefix", () => {
	it.each([false, true])("keeps serialized system checkpoints stable with restoration=%s", async (restore) => {
		const h = harness(restore);
		const first = await h.request();
		const persisted = h.manager.buildSessionContext().messages;
		h.changeBudget();
		const second = await h.request();
		expect(first.result?.systemPrompt).toBeUndefined();
		expect(second.result?.systemPrompt).toBeUndefined();
		expect(first.result?.message?.display).toBe(false);
		expect(JSON.stringify(first.payload.system)).toBe(JSON.stringify(second.payload.system));
		expect(first.payload.system).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ cache_control: expect.objectContaining({ type: "ephemeral" }) }),
			]),
		);
		expect(first.payload.messages).toEqual(second.payload.messages);
		expect(h.manager.buildSessionContext().messages).toEqual(persisted);
		expect(second.result?.message).toBeUndefined();
	});
});
