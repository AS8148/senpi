/**
 * The `effect_status` record and the pending-transition bus behind it.
 *
 * Effect and admission ledgers call `noteSessionEffect` the moment they persist a transition; the host
 * delivers each note to matching `effects: true` subscriptions only AFTER the record that caused the
 * transition is on the connection's FIFO. Two drain points guarantee that ordering: the writer's
 * post-publish hook drains a session's notes synchronously after every record it publishes for that
 * session (the response to the effect command included), and a coalesced microtask flush covers
 * transitions a ledger records from inside a session event (an `agent_idle` seal, a `model_changed`),
 * which always run after that event's record was enqueued.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import type { EffectStatus } from "./effect-record.ts";

/** One `effect_status` record as it travels on the wire (docs/rpc.md, "Session status stream"). */
export interface SessionEffectStatusRecord {
	readonly type: "effect_status";
	readonly subscriptionId: string;
	readonly seq: number;
	readonly sessionId: string;
	readonly effectId: string;
	readonly kind: EffectStatus["kind"];
	readonly state: EffectStatus["state"];
	readonly disposition?: string;
	readonly outcome?: EffectStatus["outcome"];
	readonly by?: EffectStatus["by"];
	readonly at: string;
}

export function effectStatusRecord(
	subscription: { readonly id: string; readonly seq: number },
	sessionId: string,
	status: EffectStatus,
	at: string,
): SessionEffectStatusRecord {
	return {
		type: "effect_status",
		subscriptionId: subscription.id,
		seq: subscription.seq,
		sessionId,
		effectId: status.effectId,
		kind: status.kind,
		state: status.state,
		...(status.disposition === undefined ? {} : { disposition: status.disposition }),
		...(status.outcome === undefined ? {} : { outcome: status.outcome }),
		...(status.by === undefined ? {} : { by: status.by }),
		at,
	};
}

export type SessionEffectFlusher = (session: AgentSession, statuses: readonly EffectStatus[]) => void;

const pending = new WeakMap<AgentSession, EffectStatus[]>();
const dirty = new Set<AgentSession>();
let flusher: SessionEffectFlusher | undefined;
let scheduled = false;

/** A ledger persisted a transition: hold it until the causing record is published, then deliver. */
export function noteSessionEffect(session: AgentSession, status: EffectStatus): void {
	const list = pending.get(session) ?? [];
	list.push(status);
	pending.set(session, list);
	dirty.add(session);
	if (!scheduled && flusher !== undefined) {
		scheduled = true;
		queueMicrotask(flushDirty);
	}
}

/** Take a session's held transitions; the writer calls this right after publishing its causing record. */
export function drainSessionEffects(session: AgentSession): readonly EffectStatus[] {
	const list = pending.get(session) ?? [];
	if (list.length > 0) pending.set(session, []);
	return list;
}

function flushDirty(): void {
	scheduled = false;
	for (const session of [...dirty]) {
		dirty.delete(session);
		const drained = drainSessionEffects(session);
		if (drained.length > 0) flusher?.(session, drained);
	}
}

/** The host installs exactly one flusher; it resolves the session's routing id and publishes. */
export function installSessionEffectFlusher(install: SessionEffectFlusher): void {
	flusher = install;
	if (!scheduled && dirty.size > 0) {
		scheduled = true;
		queueMicrotask(flushDirty);
	}
}
