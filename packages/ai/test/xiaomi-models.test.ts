import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";

const XIAOMI_PROVIDERS = ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const;
// models.dev deprecated the v2.5 line in favor of v2.6 (senpi v2026.10.16 release). A deprecated model the
// provider still lists stays usable, labeled deprecated, until models.dev removes it.
const DEPRECATED_MODEL_IDS = ["mimo-v2-flash", "mimo-v2-omni", "mimo-v2-pro", "mimo-v2.5", "mimo-v2.5-pro"] as const;
const REPLACEMENT_MODEL_IDS = ["mimo-v2.6-flash", "mimo-v2.6-pro"] as const;

describe("Xiaomi MiMo models", () => {
	it.each(XIAOMI_PROVIDERS)("keeps deprecated models listed upstream on %s, labeled deprecated", (provider) => {
		const deprecated = getModels(provider).filter((model) =>
			(DEPRECATED_MODEL_IDS as readonly string[]).includes(model.id),
		);
		expect(deprecated.length).toBeGreaterThan(0);
		for (const model of deprecated) expect(model.deprecated).toBe(true);
	});

	it.each(XIAOMI_PROVIDERS)("keeps replacement models on %s", (provider) => {
		const modelIds = getModels(provider).map((model) => model.id);
		for (const modelId of REPLACEMENT_MODEL_IDS) expect(modelIds).toContain(modelId);
		for (const model of getModels(provider)) {
			if ((REPLACEMENT_MODEL_IDS as readonly string[]).includes(model.id)) expect(model.deprecated).toBeUndefined();
		}
	});
});
