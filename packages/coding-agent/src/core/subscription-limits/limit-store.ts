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

/** What one usage-endpoint poll learned about an account: its full window set, or why it could not ask. */
export type PollReport =
	| { readonly windows: readonly LimitWindow[]; readonly plan?: string; readonly reportedAt: Date }
	| { readonly error: string; readonly reportedAt: Date };

type Listener = (limits: AccountLimits) => void;

export class SubscriptionLimitStore {
	readonly #accounts = new Map<string, AccountLimits>();
	readonly #listeners = new Set<Listener>();

	/** Keeps the windows one response reported; a window it did not mention keeps its last value. */
	record(provider: string, account: string, windows: readonly LimitWindow[], now = new Date()): void {
		if (windows.length === 0) return;
		const key = `${provider}\u0000${account}`;
		const previous = this.#accounts.get(key);
		const merged = new Map((previous?.windows ?? []).map((window) => [window.id, window]));
		for (const window of windows) merged.set(window.id, window);
		this.#publish(key, {
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
		if (previous !== undefined && reportedAt < previous.reportedAt) return;
		if ("error" in report) {
			if (previous?.error === report.error) return;
			this.#publish(key, { ...(previous ?? { provider, account, windows: [], reportedAt }), error: report.error });
			return;
		}
		if (report.windows.length === 0 && previous === undefined) return;
		this.#publish(key, {
			provider,
			account,
			windows: [...report.windows],
			reportedAt,
			...(report.plan === undefined ? {} : { plan: report.plan }),
		});
	}

	/**
	 * Takes another isolate's record as it stands (senpi#3695: the host and its session workers each hold a
	 * store and mirror each other). An older record, or one identical to what is held, is ignored; that is
	 * what ends the echo when the mirrored record comes straight back. Two different records can share a
	 * reportedAt (`report()` keeps it when only the error changes); the tie goes to the one that sorts later,
	 * so every store settles on the same record whatever order they arrive in, and the echo ends.
	 */
	adopt(limits: AccountLimits): void {
		const key = `${limits.provider}\u0000${limits.account}`;
		const previous = this.#accounts.get(key);
		if (previous !== undefined) {
			if (limits.reportedAt < previous.reportedAt) return;
			if (limits.reportedAt === previous.reportedAt && canonical(limits) <= canonical(previous)) return;
		}
		this.#publish(key, limits);
	}

	#publish(key: string, limits: AccountLimits): void {
		this.#accounts.set(key, limits);
		// A listener is a broadcast to clients: its failure (a closed sink) must never reach the provider
		// response this runs inside, so it is reported and contained here.
		for (const listener of this.#listeners) {
			try {
				listener(limits);
			} catch (error) {
				process.stderr.write(`senpi subscription limits: a listener failed: ${String(error)}\n`);
			}
		}
	}

	snapshot(): readonly AccountLimits[] {
		return [...this.#accounts.values()];
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}
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
