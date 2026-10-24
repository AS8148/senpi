import { collectMrtrForm } from "../../core/extensions/builtin/mcp/modern/elicitation.ts";
import type { ExtensionUIContext } from "../../core/extensions/types.ts";
import type { McpFormBinding, McpFormInput } from "../../core/mcp-form-types.ts";
import { McpPresenterAuthority } from "../rpc/mcp-presenter-authority.ts";

/** The terminal itself is the principal; an RPC attachment never receives this handle. */
export function registerLocalMcpPresenter(
	ui: ExtensionUIContext,
	sessionId: string,
	lifetime: AbortSignal,
	admit: () => void,
): McpFormBinding {
	const authority = new McpPresenterAuthority();
	const binding = authority.bind(sessionId, sessionId, admit);
	let activeInput: McpFormInput | undefined;
	const drafts = new Map<string, AbortController>();
	const sender = authority.connect("local_tui", (frame) => {
		if (frame.type !== "mcp_form_request") {
			drafts.get(frame.dialogId)?.abort();
			drafts.delete(frame.dialogId);
			return true;
		}
		const input = activeInput;
		if (!input) return false;
		const draft = new AbortController();
		drafts.set(frame.dialogId, draft);
		const signal = AbortSignal.any([input.operationSignal, input.presentationSignal, lifetime, draft.signal]);
		const { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision } = frame;
		const envelope = { sessionId, bindingEpoch, attachmentEpoch, grantId, dialogId, dialogToken, formRevision };
		void collectMrtrForm(
			{
				ui,
				signal,
				presented: () => authority.receive(sender, { ...envelope, type: "mcp_form_presented" }),
			},
			`${frame.server.label} (${frame.server.source})`,
			{ message: frame.message, requestedSchema: frame.schema },
			signal,
		)
			.then(
				(result) => {
					if (!signal.aborted) authority.receive(sender, { ...envelope, type: "mcp_form_response", ...result });
				},
				() => authority.withdraw(sender),
			)
			.finally(() => drafts.delete(frame.dialogId));
		return true;
	});
	authority.attach(sender, binding);
	const owner = authority.enroll();
	owner.acquire(owner.register(binding, sender, { kind: "local_tui" }));
	const dispose = () => {
		authority.dispose();
		for (const draft of drafts.values()) draft.abort();
		drafts.clear();
	};
	lifetime.addEventListener("abort", dispose, { once: true });
	const privateForms: McpFormBinding = {
		epoch: binding.epoch,
		signal: binding.signal,
		capture: () => {
			const presentation = binding.capture();
			if (!presentation) return undefined;
			return {
				...presentation,
				present: (input) => {
					activeInput = input;
					return presentation.present(input).finally(() => {
						if (activeInput === input) activeInput = undefined;
					});
				},
			};
		},
		dispose,
	};
	if (lifetime.aborted) dispose();
	return privateForms;
}
