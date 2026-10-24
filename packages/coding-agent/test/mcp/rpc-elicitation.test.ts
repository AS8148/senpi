import { expect, it, vi } from "vitest";
import { runElicitationForm } from "../../src/core/extensions/builtin/mcp/elicitation.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { createIdentityHarness } from "../suite/rpc-client-identity-harness.ts";

it.each([
	{ reply: { cancelled: true }, expected: { action: "decline" } },
	{ reply: { value: "Yes" }, expected: { action: "accept", content: { confirmed: true } } },
	{ reply: { value: "No" }, expected: { action: "accept", content: { confirmed: false } } },
	{ reply: { value: " YES " }, expected: { action: "accept", content: { confirmed: true } } },
	{ reply: { value: "n" }, expected: { action: "accept", content: { confirmed: false } } },
	{ reply: { value: "not an answer" }, expected: { action: "decline" } },
])("preserves an RPC boolean form answer $reply", async ({ reply, expected }) => {
	const host = await createIdentityHarness();
	const bound = Promise.withResolvers<ExtensionUIContext>();
	const bindExtensions = host.session.bindExtensions.bind(host.session);
	const spy = vi.spyOn(host.session, "bindExtensions").mockImplementation(async (bindings) => {
		if (bindings.uiContext) bound.resolve(bindings.uiContext);
		return bindExtensions(bindings);
	});
	try {
		const connection = host.bind();
		const ui = await bound.promise;
		const request = connection.waitFor((record) => record.type === "extension_ui_request", 5_000);
		const result = runElicitationForm(ui, "Confirm operation", {
			properties: { confirmed: { type: "boolean" } },
			required: ["confirmed"],
		});
		const frame = await request;
		expect(frame.method).toBe("select");
		await connection.send({ type: "extension_ui_response", uiRequestId: frame.id, ...reply });
		expect(await result).toEqual(expected);
	} finally {
		spy.mockRestore();
		await host.cleanup();
	}
});
