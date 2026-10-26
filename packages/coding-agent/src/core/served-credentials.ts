import { createHash } from "node:crypto";
import { type AssistantMessage, sanitizeProviderDiagnostic } from "@earendil-works/pi-ai";

/** How long a served response vouches for its credential (senpi#2491). */
export const CREDENTIAL_SERVED_WINDOW_MS = 10 * 60_000;

export interface RequestCredential {
	readonly provider: string;
	readonly baseUrl: string | undefined;
	readonly apiKey: string | undefined;
}

/**
 * When each credential last served a response, keyed by a one-way hash of provider, endpoint and key so no
 * key material is held. An `auth` failure on a credential that served within the window is marked on its
 * message: a gateway refused that request while the key kept working for others (senpi#2491).
 */
export class ServedCredentials {
	private readonly servedAt = new Map<string, number>();
	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Reads the request's final message before any consumer does: the result promise settles them in order. */
	observe(result: Promise<AssistantMessage>, credential: RequestCredential): void {
		const key = credentialKey(credential);
		result.then((message) => this.settle(key, message), ignoreFailedRequest);
	}

	private settle(key: string, message: AssistantMessage): void {
		if (message.stopReason !== "error" && message.stopReason !== "aborted") {
			this.servedAt.set(key, this.now());
			return;
		}
		const servedAt = this.servedAt.get(key);
		if (
			message.stopReason === "error" &&
			servedAt !== undefined &&
			this.now() - servedAt <= CREDENTIAL_SERVED_WINDOW_MS &&
			sanitizeProviderDiagnostic(message.providerDiagnostic)?.category === "auth"
		) {
			message.credentialServedRecently = true;
		}
	}
}

/** A request whose stream failed outright proves nothing about its credential; its consumer owns the error. */
function ignoreFailedRequest(): void {}

function credentialKey(credential: RequestCredential): string {
	return createHash("sha256")
		.update(`${credential.provider}\0${credential.baseUrl ?? ""}\0${credential.apiKey ?? ""}`)
		.digest("hex");
}
