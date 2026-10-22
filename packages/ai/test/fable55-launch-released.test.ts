import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FABLE55_LAUNCH } from "../src/utils/fable55-launch.ts";

// senpi#3893: flipping `released` before the regenerated catalog carries the row would silently drop the Fable slot.
const catalogPath = fileURLToPath(new URL("../src/providers/data/anthropic.json", import.meta.url));
const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as Record<string, Record<string, { id: string }>>;
const anthropicIds = new Set(Object.values(catalog).flatMap((group) => Object.values(group).map((model) => model.id)));

describe("Fable 5.5 launch block consistency", () => {
	it("marks the model released only when the committed anthropic catalog lists it", () => {
		expect(FABLE55_LAUNCH.released).toBe(anthropicIds.has(FABLE55_LAUNCH.modelId));
	});

	it("never promotes defaults for an unreleased model", () => {
		expect(!FABLE55_LAUNCH.promoteDefaults || FABLE55_LAUNCH.released).toBe(true);
	});
});
