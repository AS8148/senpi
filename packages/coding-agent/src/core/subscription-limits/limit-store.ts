/**
 * The latest limit windows each subscription account reported, kept for the life of the process and
 * shared by every session on it (one account's windows are the same whichever session asked). An account
 * is named by its credential slot - the stored account's name, `env` for an environment key, `default`
 * for a single credential - never by key material. Nothing reported yet means the account is absent.
 */
import type { StreamOptions } from "@earendil-works/pi-ai";
import type { LimitWindow } from "./limit-windows.ts";
import { claudeWindowsFromHeaders, codexWindowsFromHeaders } from "./limit-windows.ts";

export interface AccountLimits {
	readonly provider: string;
	readonly account: string;
	readonly windows: readonly LimitWindow[];
	/** ISO time of the response that reported them. */
	readonly reportedAt: string;
	/** The plan the provider's usage endpoint names (`pro`, `max`, ...), when it names one. */
	readonly plan?: string;
	/**
	 * Why the last usage poll for this account failed (`sign-in needed`, `rate limited`, ...). The windows
	 * beside it are the last ones reported; the next successful report clears it (senpi#3684).
	 */
	readonly error?: string;
}

/**
 * A record as the stores of one process's isolates mirror it to each other (senpi#3695). `updatedAt` is when the
 * record last changed, set only when that differs from `reportedAt` (a failed poll adds an error beside the last
 * windows, which keep their time). It orders mirrored copies and never leaves the mirror: `snapshot()` and
 * `subscribe()` hand out the public shape.
 */
export interface MirroredLimits extends AccountLimits {
	readonly updatedAt?: string;
}

/** What one usage-endpoint poll learned about an account: its full window set, or why it could not ask. */
export type PollReport =
	| { readonly windows: readonly LimitWindow[]; readonly plan?: string; readonly reportedAt: Date }
	| { readonly error: string; readonly reportedAt: Date };

type Listener = (limits: AccountLimits) => void;
type MirrorListener = (limits: MirroredLimits) => void;

export class SubscriptionLimitStore {
	readonly #accounts = new Map<string, MirroredLimits>();
	readonly #listeners = new Set<Listener>();
	readonly #mirrorListeners = new Set<MirrorListener>();

	/** Keeps the windows one response reported; a window it did not mention keeps its last value. */
	record(provider: string, account: string, windows: readonly LimitWindow[], now = new Date()): void {
		if (windows.length === 0) return;
		const key = `${provider}\u0000${account}`;
		const previous = this.#accounts.get(key);
		const merged = new Map((previous?.windows ?? []).map((window) => [window.id, window]));
		for (const window of windows) merged.set(window.id, window);
		this.#write(key, previous, {
			provider,
			account,
			windows: [...merged.values()],
			reportedAt: now.toISOString(),
			...(previous?.plan === undefined ? {} : { plan: previous.plan }),
		});
	}

	/**
	 * Keeps what a usage-endpoint poll learned (senpi#3684). The endpoint answers with the account's whole
	 * window set, so it replaces the windows rather than merging; a failed poll keeps the last windows and
	 * says why beside them. An account with no windows and no prior record stays absent on success. A
	 * reading older than what the store already holds (a sibling's cached poll adopted after a fresher turn)
	 * is ignored, so the shown usage never goes backwards.
	 */
	report(provider: string, account: string, report: PollReport): void {
		const key = `${provider}\u0000${account}`;
		const previous = this.#accounts.get(key);
		const reportedAt = report.reportedAt.toISOString();
		if (previous !== undefined && reportedAt < orderOf(previous)) return;
		if ("error" in report) {
			if (previous?.error === report.error) return;
			const { updatedAt: _previousOrder, ...base } = previous ?? { provider, account, windows: [], reportedAt };
			this.#write(key, previous, { ...base, error: report.error }, reportedAt);
			return;
		}
		if (report.windows.length === 0 && previous === undefined) return;
		this.#write(key, previous, {
			provider,
			account,
			windows: [...report.windows],
			reportedAt,
			...(report.plan === undefined ? {} : { plan: report.plan }),
		});
	}

	/**
	 * Takes another isolate's record as it stands (senpi#3695: the host and its session workers each hold a store
	 * and mirror each other). It goes through the same total order as every local write, so whatever order the
	 * copies cross in, every store keeps the same record and the echo ends when a copy comes straight back.
	 */
	adopt(limits: MirroredLimits): void {
		this.#offer(`${limits.provider}\u0000${limits.account}`, limits);
	}

	/**
	 * The mirror's rule (senpi#3695): a copy replaces the held record only when it is strictly later in the total
	 * order (when it last changed, then its content), so two stores that see the same records keep the same one.
	 */
	/**
	 * A write from this store's own turn or poll always lands: it is ordered strictly after the held record
	 * (when `changedAt` does not already come later, by one millisecond past it), so a same-instant write is
	 * never mistaken for an older one, and a mirrored store takes it by the same total order.
	 */
	#write(
		key: string,
		previous: MirroredLimits | undefined,
		limits: AccountLimits,
		changedAt = limits.reportedAt,
	): void {
		const order = previous === undefined ? changedAt : strictlyAfter(changedAt, orderOf(previous));
		this.#publish(key, order === limits.reportedAt ? limits : { ...limits, updatedAt: order });
	}

	#offer(key: string, limits: MirroredLimits): void {
		const previous = this.#accounts.get(key);
		if (previous !== undefined && compareRecords(limits, previous) <= 0) return;
		this.#publish(key, limits);
	}

	#publish(key: string, limits: MirroredLimits): void {
		this.#accounts.set(key, limits);
		for (const listener of this.#mirrorListeners) listener(limits);
		const shown = publicShape(limits);
		// A listener is a broadcast to clients: its failure (a closed sink) must never reach the provider
		// response this runs inside, so it is reported and contained here.
		for (const listener of this.#listeners) {
			try {
				listener(shown);
			} catch (error) {
				process.stderr.write(`senpi subscription limits: a listener failed: ${String(error)}\n`);
			}
		}
	}

	snapshot(): readonly AccountLimits[] {
		return [...this.#accounts.values()].map(publicShape);
	}

	/** The records with their ordering key, for mirroring into another isolate's store. */
	mirrorSnapshot(): readonly MirroredLimits[] {
		return [...this.#accounts.values()];
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Hears every change with its ordering key, for mirroring into another isolate's store. */
	subscribeMirror(listener: MirrorListener): () => void {
		this.#mirrorListeners.add(listener);
		return () => this.#mirrorListeners.delete(listener);
	}
}

function orderOf(limits: MirroredLimits): string {
	return limits.updatedAt ?? limits.reportedAt;
}

/** The total order every store applies: when the record last changed, then its key-sorted content. */
function compareRecords(a: MirroredLimits, b: MirroredLimits): number {
	const [first, second] = [orderOf(a), orderOf(b)];
	if (first !== second) return first < second ? -1 : 1;
	const [left, right] = [canonical(a), canonical(b)];
	return left < right ? -1 : left > right ? 1 : 0;
}

function strictlyAfter(candidate: string, held: string): string {
	return candidate > held ? candidate : new Date(Date.parse(held) + 1).toISOString();
}

function publicShape({ updatedAt: _order, ...limits }: MirroredLimits): AccountLimits {
	return limits;
}

/** A key-order-independent rendering of a record, so equal records compare equal however they were built. */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, field: unknown) =>
		field !== null && typeof field === "object" && !Array.isArray(field)
			? Object.fromEntries(Object.entries(field).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: field,
	);
}

/** The process's store. */
export const subscriptionLimits = new SubscriptionLimitStore();

/** The account a request ran under, as the store names it. */
export function limitAccountOf(slotAuth: { apiKey?: string; slotName?: string } | undefined): string {
	if (slotAuth?.slotName !== undefined) return slotAuth.slotName;
	return slotAuth?.apiKey !== undefined ? "env" : "default";
}

/** Request options whose `onResponse` also records the windows the response headers carry. */
export function withLimitCapture<TOptions extends Pick<StreamOptions, "onResponse">>(
	options: TOptions,
	provider: string,
	account: string,
	store: SubscriptionLimitStore = subscriptionLimits,
): TOptions {
	const inner = options.onResponse;
	const onResponse: NonNullable<StreamOptions["onResponse"]> = (response, model) => {
		store.record(provider, account, [
			...codexWindowsFromHeaders(response.headers),
			...claudeWindowsFromHeaders(response.headers),
		]);
		return inner?.(response, model);
	};
	return { ...options, onResponse };
}
