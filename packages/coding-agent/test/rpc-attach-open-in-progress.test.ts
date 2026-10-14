import { afterEach, describe, expect, it } from "vitest";
import { attachToOpenSession } from "../src/modes/rpc/session-registry-attach.ts";
import { type RpcSessionEntry, RpcSessionRegistryError } from "../src/modes/rpc/session-registry-types.ts";

const WAIT_ENV = "SENPI_OPEN_IN_PROGRESS_WAIT_MS";
const prevEnv = process.env[WAIT_ENV];

afterEach(() => {
	if (prevEnv === undefined) delete process.env[WAIT_ENV];
	else process.env[WAIT_ENV] = prevEnv;
});

function openingEntry(openCompletion: Promise<void>): RpcSessionEntry {
	return {
		state: "opening",
		reservationKey: "/tmp/session.jsonl",
		sessionPath: "/tmp/session.jsonl",
		openCompletion,
	} as unknown as RpcSessionEntry;
}

describe("attachToOpenSession waiter bound (M1)", () => {
	it("rejects a never-settling in-flight open with session_path_in_use + open_in_progress, leaving the entry alone", async () => {
		process.env[WAIT_ENV] = "100";
		let settle!: { resolve: () => void; reject: (cause: unknown) => void };
		const openCompletion = new Promise<void>((resolve, reject) => {
			settle = { resolve, reject };
		});
		const entry = openingEntry(openCompletion);
		const entries = new Map<string, RpcSessionEntry>([["rpc-1", entry]]);

		const started = Date.now();
		const failure = await attachToOpenSession(
			entries,
			"/tmp/session.jsonl",
			{ cwd: "/tmp" } as never,
			undefined,
			undefined,
			0,
		).then(
			() => ({ ok: true as const }),
			(cause: unknown) => ({ ok: false as const, cause }),
		);
		const waitedMs = Date.now() - started;

		expect(failure.ok).toBe(false);
		expect(waitedMs).toBeGreaterThanOrEqual(90);
		expect(waitedMs).toBeLessThan(5_000);
		if (!failure.ok) {
			expect(failure.cause).toBeInstanceOf(RpcSessionRegistryError);
			expect((failure.cause as RpcSessionRegistryError).code).toBe("session_path_in_use");
			expect((failure.cause as RpcSessionRegistryError).detail).toMatchObject({ reason: "open_in_progress" });
		}

		expect(entry.state).toBe("opening");
		expect(entries.get("rpc-1")).toBe(entry);
		settle.resolve();
	});
});
