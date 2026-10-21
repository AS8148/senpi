import type { ExtensionContext, SendUserMessageHandler } from "./extensions/types.ts";

/** Engine-owned capability, not a user-asserted origin on the extension message API. */
const deliveries = new WeakMap<ExtensionContext, SendUserMessageHandler>();

export function bindQuestionInput(ctx: ExtensionContext, deliver: SendUserMessageHandler): void {
	deliveries.set(ctx, deliver);
}

export function deliverQuestionInput(
	ctx: ExtensionContext,
	content: Parameters<SendUserMessageHandler>[0],
	options: Parameters<SendUserMessageHandler>[1],
): boolean {
	const deliver = deliveries.get(ctx);
	if (!deliver) return false;
	deliver(content, options);
	return true;
}
