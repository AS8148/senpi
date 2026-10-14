import { describe, expect, it } from "vitest";
import { sanitizeProviderDiagnostic } from "../src/provider-diagnostic.ts";
import { peekProviderDiagnostic } from "../src/utils/provider-diagnostic-carrier.ts";
import {
	awaitProviderTransport,
	transportProviderDiagnosticFromError,
} from "../src/utils/provider-diagnostic-sources.ts";

// senpi#3228: a connection failure is classified `network` from a closed set of structured
// transport codes only; its message is never read.

function withCode(code: string, viaCause: boolean): Error {
	const socket = Object.assign(new Error("socket failure"), { code });
	return viaCause ? new Error("Connection error.", { cause: socket }) : socket;
}

describe("transport provider diagnostic", () => {
	it.each([
		["ECONNRESET", false],
		["ECONNREFUSED", true],
		["ENOTFOUND", true],
		["UND_ERR_SOCKET", true],
	])("classifies %s (via cause: %s) as network", (code, viaCause) => {
		expect(transportProviderDiagnosticFromError(withCode(code, viaCause))).toEqual({
			category: "network",
			code,
			evidence: "structured_transport",
		});
	});

	it("ignores a transport-looking message without a structured code", () => {
		expect(transportProviderDiagnosticFromError(new Error("ECONNRESET: socket hang up"))).toBeUndefined();
	});

	it("ignores an unlisted code", () => {
		expect(transportProviderDiagnosticFromError(withCode("EACCES", false))).toBeUndefined();
	});

	it("keeps an adapter's own verdict and adds network only when the adapter found nothing", async () => {
		const failure = withCode("ECONNRESET", true);
		await expect(
			awaitProviderTransport(
				() => Promise.reject(failure),
				() => undefined,
			),
		).rejects.toBe(failure);
		expect(peekProviderDiagnostic(failure)).toMatchObject({ category: "network", code: "ECONNRESET" });
	});

	it("revalidates a network diagnostic across a boundary and rejects a forged one", () => {
		expect(
			sanitizeProviderDiagnostic({ category: "network", code: "ECONNRESET", evidence: "structured_transport" }),
		).toEqual({
			category: "network",
			code: "ECONNRESET",
			evidence: "structured_transport",
		});
		expect(
			sanitizeProviderDiagnostic({ category: "network", code: "EACCES", evidence: "structured_transport" }),
		).toBeUndefined();
		expect(
			sanitizeProviderDiagnostic({
				category: "network",
				httpStatus: 503,
				code: "ECONNRESET",
				evidence: "structured_transport",
			}),
		).toBeUndefined();
	});
});
