/**
 * The one projection of a session's events into RPC records: invocation metadata and `agent_end` go through
 * client-message correlation, model and thinking changes carry the selection provenance, and an aborted
 * `agent_end` names its abort source. A host connection and a terminal control endpoint both stream a
 * session through this, so an attached client reads the same records from either.
 */
import type { AgentAbortSource } from "../../core/agent-abort-provenance.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { ClientMessageEvents } from "./client-message-events.ts";
import type { RpcCommandInvocationEvent, RpcSkillInvocationEvent } from "./rpc-types.ts";

/** Subscribes `output` to the session's records; returns the unsubscribe. */
export function subscribeSessionRecords(
	session: AgentSession,
	output: (record: object) => void,
	onAbortSource: (source: AgentAbortSource) => void = () => {},
): () => void {
	const correlatedEvents = new ClientMessageEvents(output, () => ClientAdmissions.forSession(session).hasIdentities);
	return session.subscribe((event) => {
		if (event.type === "skill_invocation") {
			correlatedEvents.accept(event satisfies RpcSkillInvocationEvent);
			return;
		}
		if (event.type === "command_invocation") {
			correlatedEvents.accept(event satisfies RpcCommandInvocationEvent);
			return;
		}
		if (event.type === "thinking_level_changed" || event.type === "model_changed") {
			// Core emits the effective level only; the selection provenance lives beside it
			// on the session and is what distinguishes an explicit choice from a default.
			const thinkingSelection = session.thinkingSelection;
			output(thinkingSelection === undefined ? event : { ...event, thinkingSelection });
			return;
		}
		if (event.type === "agent_end") {
			// The subscribe-path `agent_end` carries only { type, messages, willRetry };
			// the abort provenance the extension hook receives is stripped from it. Read
			// it from the session, which still reports the owner at this point, and retain
			// it for `get_state` because the getter clears once the turn settles.
			const abortSource = session.currentAbortSource;
			if (abortSource !== undefined) onAbortSource(abortSource);
			correlatedEvents.accept(abortSource === undefined ? event : { ...event, aborted: true, abortSource });
			return;
		}
		correlatedEvents.accept(event);
	});
}
