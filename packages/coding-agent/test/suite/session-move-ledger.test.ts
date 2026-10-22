import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MoveFencedError, MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function ledger(): MoveLedger {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-move-ledger-")));
	dirs.push(dir);
	return new MoveLedger(dir);
}
const id = (value: string) => value as MoveId;

describe("MoveLedger fence", () => {
	it("#given an accepted move, revoked or not #when another receive begins #then it is fenced", async () => {
		const book = ledger();
		for (const [move, revoke] of [
			[id("a1"), false],
			[id("a2"), true],
		] as const) {
			await book.prepare(move);
			await book.beginReceive(move);
			await book.commit(move, () => undefined);
			if (revoke) await book.markRevoked(move);
			await expect(book.beginReceive(move)).rejects.toBeInstanceOf(MoveFencedError);
		}
	});

	it("#given a revoke whose record was lost or reset to plain accepted #when the revoke repeats #then revoked: true is back", async () => {
		const book = ledger();
		await book.prepare(id("v1"));
		await book.beginReceive(id("v1"));
		await book.commit(id("v1"), () => undefined);
		await book.markRevoked(id("v1"));
		const record = join(book.dir, "v1.json");

		rmSync(record);
		await book.markRevoked(id("v1"));
		expect(await book.answerStatus(id("v1"), { movedIn: false })).toEqual({ state: "accepted", revoked: true });

		writeFileSync(record, `${JSON.stringify({ state: "accepted" })}\n`);
		expect(await book.answerStatus(id("v1"), { movedIn: false })).toEqual({ state: "accepted" });
		await book.markRevoked(id("v1"));
		expect(await book.answerStatus(id("v1"), { movedIn: false })).toEqual({ state: "accepted", revoked: true });
	});

	it("#given no record #when the sender asks #then the answer is a durable decline that blocks a later import", async () => {
		const book = ledger();
		expect(await book.answerStatus(id("m1"), { movedIn: false })).toEqual({ state: "declined", reason: "no_record" });
		await expect(book.beginReceive(id("m1"))).rejects.toBeInstanceOf(MoveFencedError);
		await expect(book.commit(id("m1"), () => undefined)).rejects.toBeInstanceOf(MoveFencedError);
	});

	it("#given a receive in progress #when the sender asks #then it hears receiving and nothing is declined", async () => {
		const book = ledger();
		await book.prepare(id("m2"));
		await book.beginReceive(id("m2"));
		expect(await book.answerStatus(id("m2"), { movedIn: false })).toEqual({ state: "receiving" });
		await book.commit(id("m2"), () => undefined);
		expect(await book.answerStatus(id("m2"), { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given an accepted move whose session was later deleted #when the sender asks #then it still hears accepted", async () => {
		const book = ledger();
		await book.prepare(id("m3"));
		await book.beginReceive(id("m3"));
		await book.commit(id("m3"), () => undefined);
		expect(await book.answerStatus(id("m3"), { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given an accepted move #when a cancel or expiry arrives #then it never turns into a decline", async () => {
		const book = ledger();
		await book.prepare(id("m4"));
		await book.beginReceive(id("m4"));
		await book.commit(id("m4"), () => undefined);
		expect(await book.decline(id("m4"), "cancelled")).toEqual({ state: "accepted" });
	});

	it("#given a commit whose rename throws #then nothing is recorded as accepted", async () => {
		const book = ledger();
		await book.prepare(id("m5"));
		await book.beginReceive(id("m5"));
		await expect(
			book.commit(id("m5"), () => {
				throw new Error("disk full");
			}),
		).rejects.toThrow("disk full");
		expect(await book.answerStatus(id("m5"), { movedIn: false })).toEqual({ state: "receiving" });
	});
});
