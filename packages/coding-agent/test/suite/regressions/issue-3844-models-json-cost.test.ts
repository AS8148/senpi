import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createModelRegistry, getModelRuntime } from "../../model-runtime-test-utils.ts";

let tempDir: string | undefined;

afterEach(() => {
	if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

async function runtimeWith(providers: Record<string, unknown>) {
	tempDir = mkdtempSync(join(tmpdir(), "senpi-models-json-cost-"));
	const modelsPath = join(tempDir, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers }));
	return getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), modelsPath));
}

function usage(input: number, output: number): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

// Any priced zai catalog model: the test is about inheriting whatever price the built-in entry has (senpi#1955).
const PRICED_ZAI_ID = getBuiltinModels("zai").find((model) => model.cost.output > 0)?.id ?? "";

async function catalogModel(): Promise<Model<Api>> {
	const model = getModelRuntime(await createModelRegistry(AuthStorage.inMemory(), undefined)).getModel(
		"zai",
		PRICED_ZAI_ID,
	);
	if (model === undefined) throw new Error("the built-in zai catalog has no priced model");
	return model;
}

describe("models.json model prices (senpi#3844)", () => {
	it("#given a models[] entry that repeats a built-in model without cost #when it is composed #then it keeps the built-in price", async () => {
		// given
		const catalog = await catalogModel();
		const runtime = await runtimeWith({ zai: { models: [{ id: PRICED_ZAI_ID, name: "GLM-5.3 (mine)" }] } });

		// when
		const model = runtime.getModel("zai", PRICED_ZAI_ID);

		// then: the entry still applies (name), and the price is the catalog's, not zero
		expect(catalog.cost.output).toBeGreaterThan(0);
		expect(model?.name).toBe("GLM-5.3 (mine)");
		expect(model?.cost).toEqual(catalog.cost);
	});

	it("#given a models[] entry that repeats a built-in model with its own cost #when it is composed #then the entry's price wins", async () => {
		// given
		const runtime = await runtimeWith({
			zai: { models: [{ id: PRICED_ZAI_ID, cost: { input: 2, output: 9, cacheRead: 0.5, cacheWrite: 0 } }] },
		});

		// when
		const model = runtime.getModel("zai", PRICED_ZAI_ID);

		// then
		expect(model?.cost).toEqual({ input: 2, output: 9, cacheRead: 0.5, cacheWrite: 0 });
	});

	it("#given a custom model with no price anywhere #when a turn is billed #then its cost is unknown, not $0", async () => {
		// given
		const runtime = await runtimeWith({
			"my-gateway": {
				baseUrl: "https://example.invalid/v1",
				api: "openai-completions",
				models: [{ id: "house-model" }],
			},
		});
		const model = runtime.getModel("my-gateway", "house-model");
		expect(model).toBeDefined();
		if (model === undefined) return;
		const turn = usage(1_000, 500);

		// when
		calculateCost(model, turn);

		// then
		expect(model.cost.unknown).toBe(true);
		expect(turn.costUnknown).toBe(true);
		expect(turn.cost.total).toBe(0);
	});

	it("#given a custom model whose price is explicitly zero #when a turn is billed #then it is a real $0", async () => {
		// given
		const runtime = await runtimeWith({
			"my-gateway": {
				baseUrl: "https://example.invalid/v1",
				api: "openai-completions",
				models: [{ id: "free-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
			},
		});
		const model = runtime.getModel("my-gateway", "free-model");
		expect(model).toBeDefined();
		if (model === undefined) return;
		const turn = usage(1_000, 500);

		// when
		calculateCost(model, turn);

		// then
		expect(model.cost.unknown).toBeUndefined();
		expect(turn.costUnknown).toBeUndefined();
		expect(turn.cost.total).toBe(0);
	});

	it("#given hideFreeModels #when a custom model has an unknown price and another is explicitly free #then only the free one is hidden", async () => {
		// given
		const runtime = await runtimeWith({
			"my-gateway": {
				baseUrl: "https://example.invalid/v1",
				api: "openai-completions",
				hideFreeModels: true,
				models: [
					{ id: "house-model" },
					{ id: "free-model", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
				],
			},
		});

		// when
		const unknownPrice = runtime.getModel("my-gateway", "house-model");
		const free = runtime.getModel("my-gateway", "free-model");

		// then
		expect(unknownPrice).toBeDefined();
		expect(free).toBeUndefined();
	});

	it("#given a custom model whose id matches nothing in a built-in provider #when it is composed #then it does not borrow another model's price", async () => {
		// given: findModelDefaults falls back to a different zai model for api/baseUrl; its price must not follow
		const catalog = await catalogModel();
		const runtime = await runtimeWith({ zai: { models: [{ id: "glm-private-preview" }] } });

		// when
		const model = runtime.getModel("zai", "glm-private-preview");

		// then
		expect(model?.baseUrl).toBe(catalog.baseUrl);
		expect(model?.cost.unknown).toBe(true);
	});
});
