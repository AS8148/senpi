// MCP elicitation form mode (todo 41): capability declared empty; the form
// walks flat primitives through ui.input/select; missing UI or a
// missing required answer declines; the bounded timeout cancels; numbers
// parse or decline; URL-mode requests decline (v1 is form-only).

import { describe, expect, it } from "vitest";
import {
	MCP_CLIENT_ELICITATION_CAPABILITY,
	runElicitationForm,
} from "../../src/core/extensions/builtin/mcp/elicitation.ts";

const SCHEMA = {
	properties: {
		confirmed: { type: "boolean" },
		count: { type: "integer" },
		mode: { enum: ["alpha", "beta"], type: "string" },
		name: { type: "string" },
	},
	required: ["name"],
};

function scriptedUi(overrides: Partial<Record<"input" | "select" | "confirm", unknown>> = {}) {
	return {
		confirm: async () => true,
		input: async (title: string) => (title.includes("count") ? "42" : "Ada"),
		select: async (title: string) => (title.includes("confirmed") ? "Yes" : "beta"),
		...overrides,
	} as never;
}

describe("mcp elicitation form", () => {
	it("declares the capability as an empty object", () => {
		expect(MCP_CLIENT_ELICITATION_CAPABILITY).toEqual({ elicitation: {} });
	});

	it("declines an automated task parent's cancellation without fabricating boolean values", async () => {
		const response = await runElicitationForm(
			scriptedUi({ confirm: async () => false, select: async () => undefined }),
			"Server asks",
			{ properties: { confirmed: { type: "boolean" } }, required: ["confirmed"] },
		);
		expect(response).toEqual({ action: "decline" });
	});

	it.each([
		["Yes", true],
		["No", false],
		[" yes ", true],
		["y", true],
		["true", true],
		[" NO ", false],
		["n", false],
		["false", false],
	] as const)("accepts an explicit human %s as boolean %s", async (answer, expected) => {
		const response = await runElicitationForm(scriptedUi({ select: async () => answer }), "Server asks", {
			properties: { confirmed: { type: "boolean" } },
			required: ["confirmed"],
		});
		expect(response).toEqual({ action: "accept", content: { confirmed: expected } });
	});

	it("declines an unrecognized boolean selection without field values", async () => {
		const response = await runElicitationForm(scriptedUi({ select: async () => "not an answer" }), "Server asks", {
			properties: { confirmed: { type: "boolean" } },
		});
		expect(response).toEqual({ action: "decline" });
	});

	it.each<Parameters<typeof runElicitationForm>[2]>([
		{ properties: { name: { type: "string" } } },
		{ properties: {} },
	])("declines automated cancellation even without required fields: %j", async (schema) => {
		const response = await runElicitationForm(
			scriptedUi({ input: async () => undefined, select: async () => undefined }),
			"Server asks",
			schema,
		);
		expect(response).toEqual({ action: "decline" });
	});

	it("accepts a human's explicit submission of a form with no field values", async () => {
		const response = await runElicitationForm(scriptedUi({ select: async () => "Submit" }), "Server asks", {
			properties: {},
		});
		expect(response).toEqual({ action: "accept", content: {} });
	});

	it("accepts with typed values from scripted ui answers", async () => {
		const response = await runElicitationForm(scriptedUi(), "Server asks", SCHEMA);
		expect(response).toEqual({
			action: "accept",
			content: { confirmed: true, count: 42, mode: "beta", name: "Ada" },
		});
	});

	it("declines when a required answer is missing and on invalid numbers", async () => {
		const missing = await runElicitationForm(scriptedUi({ input: async () => undefined }), "Ask", SCHEMA);
		expect(missing.action).toBe("decline");

		const badNumber = await runElicitationForm(
			scriptedUi({ input: async (title: string) => (title.includes("count") ? "not-a-number" : "Ada") }),
			"Ask",
			SCHEMA,
		);
		expect(badNumber.action).toBe("decline");
	});

	it("cancels via the bounded timeout without wedging", async () => {
		const hangingUi = scriptedUi({ input: () => new Promise(() => undefined) });
		const response = await runElicitationForm(hangingUi, "Ask", SCHEMA, 50);
		expect(response).toEqual({ action: "cancel" });
	});
});
