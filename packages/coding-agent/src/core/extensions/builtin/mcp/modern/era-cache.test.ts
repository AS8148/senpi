import { describe, expect, it, vi } from "vitest";
import type { EraOutcome } from "./era.ts";
import { EraCache } from "./era-cache.ts";

const modern: EraOutcome = { kind: "modern-OK", version: "2026-07-28" };
const legacy: EraOutcome = { kind: "legacy-fallback" };

describe("session era cache", () => {
	it("shares HTTP origins but isolates stdio process identities and sessions", async () => {
		const cache = new EraCache();
		const probe = vi.fn(async () => modern);
		const process = {};
		await cache.resolve({ kind: "http", url: new URL("https://fixture.test/a") }, probe);
		await cache.resolve({ kind: "http", url: new URL("https://fixture.test/b") }, probe);
		await cache.resolve({ kind: "stdio", process }, probe);
		await cache.resolve({ kind: "stdio", process }, probe);
		await cache.resolve({ kind: "stdio", process: {} }, probe);
		await new EraCache().resolve({ kind: "stdio", process }, probe);
		expect(probe).toHaveBeenCalledTimes(4);
	});

	it("clears an inconsistent era and re-probes once before retrying", async () => {
		const cache = new EraCache();
		const key = { kind: "stdio", process: {} } as const;
		const probe = vi.fn(async (): Promise<EraOutcome> => legacy).mockResolvedValueOnce(modern);
		const request = vi.fn(async (_era: EraOutcome) => ({ error: { code: -32601, message: "Method not found" } }));
		await cache.request(key, probe, request);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[1]?.[0]).toEqual(legacy);
		expect(await cache.resolve(key, probe)).toEqual(legacy);
	});

	it("re-probes a cached legacy era when a modern error arrives", async () => {
		const cache = new EraCache();
		const key = { kind: "http", url: new URL("https://fixture.test") } as const;
		const probe = vi.fn(async (): Promise<EraOutcome> => modern).mockResolvedValueOnce(legacy);
		const request = vi.fn(async () => ({ error: { code: -32022, message: "UnsupportedProtocolVersionError" } }));
		await cache.request(key, probe, request);
		expect(probe).toHaveBeenCalledTimes(2);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not invalidate consistent errors or cache indeterminate outcomes", async () => {
		const cache = new EraCache();
		const key = { kind: "stdio", process: {} } as const;
		const probe = vi.fn(async () => modern);
		await cache.request(key, probe, async () => ({ error: { code: -32602, message: "Invalid params" } }));
		await cache.resolve(key, probe);
		expect(probe).toHaveBeenCalledTimes(1);
		cache.clear();
		const failed = vi.fn(
			async (): Promise<EraOutcome> => ({
				kind: "indeterminate",
				reason: "transport",
				action: "Check connection",
			}),
		);
		await cache.resolve(key, failed);
		await cache.resolve(key, failed);
		expect(failed).toHaveBeenCalledTimes(2);
	});

	it("coalesces concurrent probes for one origin", async () => {
		const cache = new EraCache();
		const key = { kind: "http", url: new URL("https://fixture.test") } as const;
		const probe = vi.fn(async () => modern);
		await Promise.all([cache.resolve(key, probe), cache.resolve(key, probe)]);
		expect(probe).toHaveBeenCalledTimes(1);
	});
});
