import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import { JsonlPeer, type RecordValue } from "../helpers/rpc-jsonl-peer.ts";

/**
 * Observe whether Node reports an unhandled rejection while `body` runs.
 *
 * Subscribes before triggering, then waits for either the rejection event or a
 * bounded deadline, so the check never depends on a fixed sleep landing after
 * the microtask checkpoint.
 */
async function unhandledRejectionDuring(body: () => void, settleMs = 250): Promise<unknown> {
	let onUnhandled!: (reason: unknown) => void;
	const observed = new Promise<unknown>((resolve) => {
		onUnhandled = (reason: unknown) => resolve(reason);
		process.on("unhandledRejection", onUnhandled);
		setTimeout(() => resolve(undefined), settleMs);
	});
	try {
		body();
		return await observed;
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

describe("JSONL peer waiter lifecycle", () => {
	// Every waiter in this suite is armed BEFORE the command that triggers it and
	// awaited only after that command returns. Whatever rejects in that window -
	// the timeout, or close() during teardown - rejects a promise nobody is
	// holding yet. A longer timeout only narrows the window; the rejection must be
	// handled from the moment the waiter exists.
	it("does not surface an unhandled rejection when an armed waiter times out before it is awaited", async () => {
		const peer = new JsonlPeer(new PassThrough(), () => {});
		let pending!: Promise<RecordValue>;

		const reason = await unhandledRejectionDuring(() => {
			pending = peer.waitFor(() => false, 1);
		});

		expect(reason).toBeUndefined();
		// The rejection still reaches the eventual awaiter; it is handled, not swallowed.
		await expect(pending).rejects.toThrow(/Timed out waiting for RPC record/);
	});

	it("does not surface an unhandled rejection when close() settles an armed waiter", async () => {
		const peer = new JsonlPeer(new PassThrough(), () => {});
		let pending!: Promise<RecordValue>;

		const reason = await unhandledRejectionDuring(() => {
			pending = peer.waitFor(() => false, 60_000);
			peer.close();
		});

		expect(reason).toBeUndefined();
		await expect(pending).rejects.toThrow(/RPC peer closed/);
	});

	it("still resolves a waiter armed before the matching record arrives", async () => {
		const stream = new PassThrough();
		const peer = new JsonlPeer(stream, () => {});

		const pending = peer.waitFor((value) => value.type === "late", 15_000);
		stream.write(`${JSON.stringify({ type: "late", ok: true })}\n`);

		expect(await pending).toMatchObject({ type: "late", ok: true });
	});
});
