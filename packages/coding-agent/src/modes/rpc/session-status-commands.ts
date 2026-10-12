/**
 * Wire answers for `subscribe_sessions`, `unsubscribe_sessions` and `set_session_context`.
 *
 * Every refusal follows the error rule: `error` keeps the stable `<code>: <reason>` string existing
 * clients switch on, and `errorData { reason, action }` says in plain words what went wrong and what the
 * caller should send instead.
 */
import { hostGeneration, hostInstanceId } from "./protocol-identity.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import {
	RPC_ERROR_INVALID_SESSION_CONTEXT,
	RPC_ERROR_INVALID_SUBSCRIPTION,
	RPC_ERROR_UNKNOWN_SESSION,
	RPC_ERROR_UNKNOWN_SUBSCRIPTION,
} from "./rpc-types.ts";
import { applyContextPatch, publishedSessionContext } from "./session-context-patch.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";
import type { SessionStatusStream } from "./session-status-stream.ts";
import { parseSubscription } from "./session-status-subscriptions.ts";

type Command<T extends RpcCommand["type"]> = Extract<RpcCommand, { type: T }>;

export function refusal(
	id: string | undefined,
	command: string,
	code: string,
	detail: { readonly reason: string; readonly action: string },
): RpcResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		error: `${code}: ${detail.reason}`,
		errorCode: code,
		errorData: { reason: detail.reason, action: detail.action },
	};
}

export function answerSubscribeSessions(
	command: Command<"subscribe_sessions">,
	connectionId: string | undefined,
	stream: SessionStatusStream,
): RpcResponse {
	if (connectionId === undefined)
		return refusal(command.id, command.type, RPC_ERROR_INVALID_SUBSCRIPTION, {
			reason: "this transport has no per-connection identity to deliver a subscription to",
			action: "connect to the host socket (senpi --mode rpc --listen) and subscribe there",
		});
	const parsed = parseSubscription(command as unknown as Readonly<Record<string, unknown>>);
	if ("refusal" in parsed) return refusal(command.id, command.type, RPC_ERROR_INVALID_SUBSCRIPTION, parsed.refusal);
	const subscribed = stream.subscribe(connectionId, parsed.options);
	return {
		id: command.id,
		type: "response",
		command: "subscribe_sessions",
		success: true,
		data: {
			subscriptionId: subscribed.subscriptionId,
			snapshot: subscribed.snapshot,
			seq: subscribed.seq,
			hostGeneration: String(hostGeneration(process.env)),
			hostInstanceId: hostInstanceId(),
		},
	};
}

export function answerUnsubscribeSessions(
	command: Command<"unsubscribe_sessions">,
	connectionId: string | undefined,
	stream: SessionStatusStream,
): RpcResponse {
	if (connectionId !== undefined && typeof command.subscriptionId === "string" && stream.unsubscribe(connectionId, command.subscriptionId))
		return { id: command.id, type: "response", command: "unsubscribe_sessions", success: true };
	return refusal(command.id, command.type, RPC_ERROR_UNKNOWN_SUBSCRIPTION, {
		reason: "this connection holds no subscription with that id",
		action: "send the subscriptionId your subscribe_sessions answer returned, on the same connection",
	});
}

export function notAttachedRefusal(command: Command<"set_session_context">): RpcResponse {
	return refusal(command.id, command.type, RPC_ERROR_UNKNOWN_SESSION, {
		reason: "this connection is not attached to that session",
		action: "attach first with open_session { sessionPath }, then patch its context",
	});
}

export function answerSetSessionContext(
	command: Command<"set_session_context">,
	entry: RpcSessionEntry,
	stream: SessionStatusStream,
): RpcResponse {
	const applied = applyContextPatch(entry.contextOverlay, command.patch);
	if ("refusal" in applied)
		return refusal(command.id, command.type, RPC_ERROR_INVALID_SESSION_CONTEXT, applied.refusal);
	entry.contextOverlay = applied.overlay;
	stream.publish(command.sessionId, "context", "client", true);
	return {
		id: command.id,
		type: "response",
		command: "set_session_context",
		success: true,
		data: { context: publishedSessionContext(entry.context, entry.contextOverlay) },
	};
}
