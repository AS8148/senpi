import type { ExtensionUIContext } from "./extensions/types.ts";

/** Local host references only. RPC capabilities and serialized UI objects cannot enter this registry. */
export interface McpMrtrPresentation {
	readonly ui: Pick<ExtensionUIContext, "select" | "input">;
	readonly signal: AbortSignal;
}
const presentations = new WeakMap<object, McpMrtrPresentation>();

export function registerMcpMrtrPresentation(ui: ExtensionUIContext, signal: AbortSignal): ExtensionUIContext {
	presentations.set(ui, { ui, signal });
	return ui;
}

export function getMcpMrtrPresentation(ui: object): McpMrtrPresentation | undefined {
	const presentation = presentations.get(ui);
	return presentation?.signal.aborted ? undefined : presentation;
}

/** Preserve host identity across runner wrapping; private dialogs still use the raw host UI. */
export function inheritMcpMrtrPresentation(
	source: ExtensionUIContext,
	wrapper: ExtensionUIContext,
): ExtensionUIContext {
	const presentation = getMcpMrtrPresentation(source);
	if (presentation) presentations.set(wrapper, presentation);
	return wrapper;
}
