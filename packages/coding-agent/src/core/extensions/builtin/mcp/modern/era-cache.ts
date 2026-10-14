import { z } from "zod";
import { type EraOutcome, modernError } from "./era.ts";

export type EraCacheKey =
	| { readonly kind: "http"; readonly url: URL }
	| { readonly kind: "stdio"; readonly process: object };
type Probe = () => Promise<EraOutcome>;

export function isEraInconsistent(era: EraOutcome, response: unknown): boolean {
	switch (era.kind) {
		case "legacy-fallback":
			return modernError(response) !== undefined;
		case "modern-OK":
		case "modern-version-retry": {
			const parsed = z.object({ error: z.object({ code: z.literal(-32601) }) }).safeParse(response);
			return parsed.success;
		}
		case "indeterminate":
			return false;
	}
}

/** Instantiate once per client session, not at module or service scope. */
export class EraCache {
	// Mutable maps are the session cache; process object identity prevents PID reuse.
	#http = new Map<string, Promise<EraOutcome>>();
	#stdio = new WeakMap<object, Promise<EraOutcome>>();

	resolve(key: EraCacheKey, probe: Probe): Promise<EraOutcome> {
		const existing = key.kind === "http" ? this.#http.get(key.url.origin) : this.#stdio.get(key.process);
		if (existing) return existing;
		const pending = Promise.resolve()
			.then(probe)
			.then(
				(outcome) => {
					if (outcome.kind === "indeterminate") this.invalidate(key, pending);
					return outcome;
				},
				(cause: unknown) => {
					this.invalidate(key, pending);
					throw cause;
				},
			);
		if (key.kind === "http") this.#http.set(key.url.origin, pending);
		else this.#stdio.set(key.process, pending);
		return pending;
	}

	invalidate(key: EraCacheKey, expected?: Promise<EraOutcome>): void {
		if (key.kind === "http") {
			if (!expected || this.#http.get(key.url.origin) === expected) this.#http.delete(key.url.origin);
		} else if (!expected || this.#stdio.get(key.process) === expected) this.#stdio.delete(key.process);
	}

	clear(): void {
		this.#http.clear();
		this.#stdio = new WeakMap();
	}

	/** Only replay requests when the caller knows the era rejection had no effects. */
	async request<T>(
		key: EraCacheKey,
		probe: Probe,
		send: (era: EraOutcome) => Promise<T>,
		inconsistent: (era: EraOutcome, response: T) => boolean = isEraInconsistent,
	): Promise<T | EraOutcome> {
		let era = await this.resolve(key, probe);
		if (era.kind === "indeterminate") return era;
		let response = await send(era);
		if (!inconsistent(era, response)) return response;
		this.invalidate(key);
		era = await this.resolve(key, probe);
		if (era.kind === "indeterminate") return era;
		response = await send(era);
		if (inconsistent(era, response)) this.invalidate(key);
		return response;
	}
}
