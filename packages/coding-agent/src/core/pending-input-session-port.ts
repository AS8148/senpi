import type { AgentMessage, QueuedInputPort } from "@earendil-works/pi-agent-core";
import type { PendingInputStore, PendingInputTransaction } from "./pending-input-store.ts";
import type { DeliveryToken } from "./pending-input-types.ts";

export interface SessionQueuedInputPortOptions {
	readonly store: PendingInputStore;
	readonly ownerId: string;
	readonly writerGeneration: number;
	readonly nextAttemptId: () => string;
}

/**
 * The session's side of the agent queues (senpi#3549). Every drain reserves the identified inputs it hands to a
 * turn, every consumption commits them, and every give-back releases them, each under the store's gate together
 * with the native buffer change. Input the store never admitted (no client id, or a legacy id) passes through.
 */
export function createSessionQueuedInputPort(options: SessionQueuedInputPortOptions): QueuedInputPort {
	const attempts = new Map<AgentMessage, DeliveryToken>();

	const reserve = async (tx: PendingInputTransaction, message: AgentMessage): Promise<boolean> => {
		const clientMessageId = clientMessageIdOf(message);
		const input = clientMessageId === undefined ? undefined : tx.current(clientMessageId);
		if (clientMessageId === undefined || input === undefined) return true;
		const token: DeliveryToken = {
			ownerId: options.ownerId,
			writerGeneration: options.writerGeneration,
			lifetimeId: input.handle.lifetimeId,
			attemptId: options.nextAttemptId(),
			clientMessageId,
		};
		await tx.apply(clientMessageId, { type: "reserve", token });
		if (tx.current(clientMessageId)?.attempt?.attemptId !== token.attemptId) return false;
		attempts.set(message, token);
		return true;
	};

	// One journal record for the whole batch: a failed write leaves every input as it was, never half delivered.
	const settle = async (
		tx: PendingInputTransaction,
		messages: readonly AgentMessage[],
		type: "consumed" | "release",
	): Promise<DeliveryToken[]> => {
		const tokens = messages.flatMap((message) => {
			const token = attempts.get(message);
			return token === undefined ? [] : [token];
		});
		if (tokens.length === 0) return tokens;
		await tx.applyAll(tokens.map((token) => ({ clientMessageId: token.clientMessageId, event: { type, token } })));
		for (const message of messages) attempts.delete(message);
		return tokens;
	};

	return {
		claim: (_queue, drain) =>
			options.store.transaction(async (tx) => {
				const claimed: AgentMessage[] = [];
				// A copy the store no longer authorizes (removed, delivered, failed) is stale and is not delivered.
				for (const message of drain()) if (await reserve(tx, message)) claimed.push(message);
				return claimed;
			}),
		commitConsumption: (_queue, messages) =>
			options.store.transaction(async (tx) => {
				await settle(tx, messages, "consumed");
			}),
		// Journal first: if the release cannot be recorded the input stays `sending` (uncertain on reopen) and is
		// not put back natively, so it can never be delivered twice. A clear that won the race keeps the messages
		// out of the queue: their records are then removed too, so no record says queued with nothing behind it.
		release: (_queue, messages, restore) =>
			options.store.transaction(async (tx) => {
				const released = await settle(tx, messages, "release");
				if (restore() || released.length === 0) return;
				await tx.applyAll(
					released.map((token) => ({
						clientMessageId: token.clientMessageId,
						event: { type: "cancel", cause: "stop", consumerFenced: true },
					})),
				);
			}),
	};
}

function clientMessageIdOf(message: AgentMessage): string | undefined {
	if (message.role !== "user" || !("clientMessageId" in message)) return undefined;
	return typeof message.clientMessageId === "string" ? message.clientMessageId : undefined;
}
