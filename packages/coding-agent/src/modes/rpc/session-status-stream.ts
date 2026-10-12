/**
 * Host-level `session_status` subscriptions.
 *
 * A subscription is connection-scoped and activity-neutral: it never attaches to a session, never counts
 * toward `attachments` and never refreshes a session's idle window. Its records ride the subscribing
 * connection's own FIFO actor, and every publish is called by the writer AFTER it enqueued the record that
 * caused the change, so on a connection that is also attached the status always lands after its cause.
 * `seq` is per subscription: the snapshot carries `seq: 0` and every delta is strictly +1. Reconnecting is
 * a new subscription with a fresh snapshot; nothing is replayed.
 */
import { serializeJsonLine } from "./jsonl.ts";
import {
	type DerivedSessionStatus,
	deriveSessionStatus,
	type SessionStatusActor,
	type SessionStatusCause,
	type SessionStatusEntryView,
	type SessionStatusLastEffect,
	type SessionStatusRecord,
	type SessionStatusRuntimeView,
	type SessionStatusTerminal,
} from "./session-status.ts";
import { mirrorsRecord, type SubscriptionOptions, subscriptionMatches } from "./session-status-subscriptions.ts";

export interface SessionStatusSource {
	readonly sessionIds: () => readonly string[];
	readonly view: (
		sessionId: string,
	) => { readonly entry: SessionStatusEntryView; readonly runtime?: SessionStatusRuntimeView } | undefined;
}

export interface SessionStatusDelivery {
	readonly enqueue: (connectionId: string, line: string) => boolean;
	readonly pendingQuestions: (sessionId: string) => number;
	readonly now?: () => Date;
}

/** Optional hook a later effect ledger installs to fill `session_status.lastEffect`. */
export type SessionLastEffectProvider = (sessionId: string) => SessionStatusLastEffect | undefined;

type Subscription = {
	readonly id: string;
	readonly connectionId: string;
	readonly options: SubscriptionOptions;
	seq: number;
};

type SessionView = { readonly entry: SessionStatusEntryView; readonly runtime?: SessionStatusRuntimeView };
type LastChange = SessionStatusRecord["lastChange"];

export class SessionStatusStream {
	private readonly subscriptions = new Map<string, Subscription>();
	private readonly terminals = new Map<string, SessionStatusTerminal>();
	private readonly lastViews = new Map<string, SessionView>();
	private readonly lastChanges = new Map<string, LastChange>();
	private source: SessionStatusSource | undefined;
	private lastEffect: SessionLastEffectProvider | undefined;
	private nextSubscription = 0;

	constructor(private readonly delivery: SessionStatusDelivery) {}

	setSource(source: SessionStatusSource): void {
		this.source = source;
	}

	setLastEffectProvider(provider: SessionLastEffectProvider | undefined): void {
		this.lastEffect = provider;
	}

	get size(): number {
		return this.subscriptions.size;
	}

	subscribe(
		connectionId: string,
		options: SubscriptionOptions,
	): { readonly subscriptionId: string; readonly snapshot: readonly SessionStatusRecord[]; readonly seq: number } {
		const subscription: Subscription = {
			id: `sub-${++this.nextSubscription}`,
			connectionId,
			options,
			seq: 0,
		};
		this.subscriptions.set(subscription.id, subscription);
		const snapshot: SessionStatusRecord[] = [];
		for (const sessionId of this.source?.sessionIds() ?? []) {
			const view = this.currentView(sessionId);
			if (view === undefined || !subscriptionMatches(options, sessionId, view.entry)) continue;
			const derived = this.derive(sessionId, view);
			snapshot.push(this.recordFor(subscription, sessionId, derived, this.lastChangeOf(sessionId)));
		}
		return { subscriptionId: subscription.id, snapshot, seq: subscription.seq };
	}

	unsubscribe(connectionId: string, subscriptionId: string): boolean {
		const subscription = this.subscriptions.get(subscriptionId);
		if (subscription?.connectionId !== connectionId) return false;
		this.subscriptions.delete(subscriptionId);
		return true;
	}

	dropConnection(connectionId: string): void {
		for (const [id, subscription] of this.subscriptions)
			if (subscription.connectionId === connectionId) this.subscriptions.delete(id);
	}

	/**
	 * Publish one change. `contextOnly` changes (a `set_session_context` patch) reach only subscribers that
	 * asked for context, because nothing else in the record moved.
	 */
	publish(sessionId: string, cause: SessionStatusCause, by: SessionStatusActor, contextOnly = false): void {
		const view = this.currentView(sessionId);
		if (view === undefined) return;
		const change: LastChange = { at: (this.delivery.now?.() ?? new Date()).toISOString(), cause, by };
		this.lastChanges.set(sessionId, change);
		if (this.subscriptions.size === 0) return;
		const derived = this.derive(sessionId, view, cause);
		for (const subscription of this.subscriptions.values()) {
			if (contextOnly && !subscription.options.includeContext) continue;
			if (!subscriptionMatches(subscription.options, sessionId, view.entry)) continue;
			subscription.seq += 1;
			const record = this.recordFor(subscription, sessionId, derived, change);
			if (!this.delivery.enqueue(subscription.connectionId, serializeJsonLine(record)))
				this.subscriptions.delete(subscription.id);
		}
	}

	seal(sessionId: string, terminal: SessionStatusTerminal, cause: SessionStatusCause, by: SessionStatusActor): void {
		this.terminals.set(sessionId, terminal);
		this.publish(sessionId, cause, by);
	}

	forget(sessionId: string): void {
		this.terminals.delete(sessionId);
		this.lastViews.delete(sessionId);
		this.lastChanges.delete(sessionId);
	}

	mirrorTargets(sessionId: string, recordType: string): readonly string[] {
		if (this.subscriptions.size === 0) return [];
		const view = this.currentView(sessionId);
		if (view === undefined) return [];
		const targets = new Set<string>();
		for (const subscription of this.subscriptions.values())
			if (
				mirrorsRecord(subscription.options.mirror, recordType) &&
				subscriptionMatches(subscription.options, sessionId, view.entry)
			)
				targets.add(subscription.connectionId);
		return [...targets];
	}

	matchingConnections(sessionId: string): ReadonlyMap<string, boolean> {
		const view = this.currentView(sessionId);
		const matches = new Map<string, boolean>();
		if (view === undefined) return matches;
		for (const subscription of this.subscriptions.values())
			if (subscriptionMatches(subscription.options, sessionId, view.entry))
				matches.set(
					subscription.connectionId,
					(matches.get(subscription.connectionId) ?? false) || subscription.options.includeContext,
				);
		return matches;
	}

	/** The live view, falling back to the last one seen once the registry has dropped a sealed entry. */
	private currentView(sessionId: string): SessionView | undefined {
		const live = this.source?.view(sessionId);
		if (live !== undefined) this.lastViews.set(sessionId, live);
		return live ?? this.lastViews.get(sessionId);
	}

	private derive(sessionId: string, view: SessionView, cause?: SessionStatusCause): DerivedSessionStatus {
		return deriveSessionStatus(
			view.entry,
			view.runtime,
			{ pendingQuestions: this.delivery.pendingQuestions(sessionId) },
			this.terminals.get(sessionId),
			cause,
		);
	}

	private lastChangeOf(sessionId: string): LastChange {
		return (
			this.lastChanges.get(sessionId) ?? {
				at: (this.delivery.now?.() ?? new Date()).toISOString(),
				cause: "open",
				by: "host",
			}
		);
	}

	private recordFor(
		subscription: Subscription,
		sessionId: string,
		derived: DerivedSessionStatus,
		lastChange: LastChange,
	): SessionStatusRecord {
		const { context, ...rest } = derived;
		const lastEffect = this.lastEffect?.(sessionId);
		return {
			type: "session_status",
			subscriptionId: subscription.id,
			seq: subscription.seq,
			sessionId,
			...rest,
			...(subscription.options.includeContext ? { context } : {}),
			...(lastEffect !== undefined ? { lastEffect } : {}),
			lastChange,
		};
	}
}
