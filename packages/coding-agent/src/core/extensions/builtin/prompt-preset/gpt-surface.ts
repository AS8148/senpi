import type { TerminalOrApp } from "../../../dynamic-prompt/build.ts";

export const GPT_HANDOFF_MOMENTS: Record<TerminalOrApp, string> = {
	terminal:
		"the creation of a todo list with more than one task (in the message that creates it, after the routing line, or the next one), a todo phase change, a blocker or plan change, the final message of a turn that changed something or carried out multi-step work (a reply that answers a question - an explanation, a lookup, a review, a one-task request - is the answer itself, with no block, even when finding the answer took tool calls); the routing line is not one",
	app: "the creation of a todo list with more than one task (in the message that creates it or the next one), a todo phase change, a blocker or plan change, the final message of a turn that changed something or carried out multi-step work (a reply that answers a question - an explanation, a lookup, a review, a one-task request - is the answer itself, with no block, even when finding the answer took tool calls)",
};

/** The app surface's claim audit for the GPT cores (senpi#2377), in the one place each core reports on checks. */
export const GPT_APP_UNRUN_CHECK_RULE =
	"A check that did not run is covered by the evidence that did run; name it, with the next best check, only when no other evidence supports the claim. Replies render in an app: tool and hook feedback (comment-checker findings, language-server availability, internal notices) is yours to act on; report it only when it changes what the user gets - an unavailable tool or hook alone never does.";

/** Report slot wording on the app surface: an unrun check is listed only when nothing else covers it. */
export const GPT_APP_UNVERIFIED_SLOT = "anything left unverified that no other evidence covers";
