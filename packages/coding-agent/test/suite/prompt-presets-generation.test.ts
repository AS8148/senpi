import { describe, expect, it } from "vitest";
import { getBuiltinModels, getBuiltinProviders } from "../../../ai/src/providers/all.ts";
import { APP_NAME } from "../../src/config.ts";
import { buildDynamicSystemPrompt as buildNativeDefault } from "../../src/core/dynamic-prompt/build.ts";
import { resolvePreset as resolveNativePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import {
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	resolvePreset,
} from "../../src/core/extensions/builtin/prompt-preset/public.ts";

const catalog = getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
const options: BuildDynamicSystemPromptOptions = {
	cwd: "/fixture",
	selectedTools: ["read", "eval", "apply_patch", "todo", "ask_user_question"],
	toolSnippets: { read: "READ_SENTINEL", eval: "EVAL_SENTINEL" },
	promptGuidelines: ["GUIDELINE_SENTINEL"],
	contextFiles: [{ path: "/fixture/AGENTS.md", content: `${APP_NAME} CONTEXT_SENTINEL` }],
	skills: [],
};

describe("public prompt generation (#3104)", () => {
	it.each(["terminal", "app", "chat"] as const)("preserves Native catalog bytes on %s", (surface) => {
		// Public-generation contract: Native and a downstream host must share rendered bytes,
		// not only preset labels. Before/after capture separately checks the base implementation.
		// given
		const input = { ...options, surface };
		expect(catalog.length).toBeGreaterThan(0);
		for (const model of catalog) {
			const native = resolveNativePreset(model, { promptPreset: "auto" }, input);
			// when
			const generated = resolvePreset(model, { promptPreset: "auto" }, input);
			// then
			expect(generated, `${model.provider}/${model.id}`).toEqual(native);
			expect(generated?.prompt ?? buildDynamicSystemPrompt(input)).toBe(native?.prompt ?? buildNativeDefault(input));
		}
	});

	it("preserves explicit settings and metadata precedence", () => {
		// given
		const model = { provider: "openai", id: "gpt-5.4", promptPreset: "claude-opus-5-5" };
		// when
		const automatic = resolvePreset(model, { promptPreset: "auto" }, options);
		const forced = resolvePreset(model, { promptPreset: "gpt-5.2" }, options);
		// then
		expect(automatic).toEqual(resolveNativePreset(model, { promptPreset: "claude-opus-5-5" }, options));
		expect(forced).toEqual(resolveNativePreset(model, { promptPreset: "gpt-5.2" }, options));
		expect(automatic?.name).toBe("claude-opus-5-5");
		expect(forced?.name).toBe("gpt-5.2");
	});

	it("exposes the actual default builder for unknown models", () => {
		// given
		const model = { provider: "synthetic", id: "unknown-model" };
		// when
		const preset = resolvePreset(model, { promptPreset: "auto" }, options);
		// then
		expect(preset).toBeUndefined();
		expect(buildDynamicSystemPrompt(options)).toBe(buildNativeDefault(options));
	});

	it("isolates host identity without rewriting context or mutating global defaults", () => {
		// given
		const hostA = "HOST_A_SENTINEL";
		const hostB = "HOST_B_SENTINEL";
		for (const model of catalog) {
			const render = (input: BuildDynamicSystemPromptOptions) =>
				resolvePreset(model, { promptPreset: "auto" }, input)?.prompt ?? buildDynamicSystemPrompt(input);
			const native = render(options);
			// when
			const a = render({ ...options, appName: hostA });
			const b = render({ ...options, appName: hostB });
			// then
			expect(a.split("\n")[0]).toContain(hostA);
			expect(b.split("\n")[0]).toContain(hostB);
			expect(a.replaceAll(hostA, APP_NAME)).toBe(native);
			expect(b.replaceAll(hostB, APP_NAME)).toBe(native);
			expect(render(options)).toBe(native);
		}
	});
});
