// Regression for sisyphuslabs/omo-desktop-app#3137 (desktop#4008 handover): overlapping imports of one move.
import { appendFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { MOVE, setup } from "./session-move-fixture.ts";

const beforeVerify = vi.hoisted(() => new Map<string, () => Promise<void>>());

vi.mock("../../src/core/session-move/bundle.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/session-move/bundle.ts")>();
	return {
		...actual,
		verifyBundle: async (...args: Parameters<typeof actual.verifyBundle>) => {
			await beforeVerify.get(args[0])?.();
			return actual.verifyBundle(...args);
		},
	};
});

class LosesAcceptedWrite extends MoveLedger {
	landed: string | undefined;

	override commit<T>(moveId: MoveId, rename: () => T | Promise<T>): Promise<T> {
		return super.commit(moveId, async () => {
			this.landed = String(await rename());
			throw new Error("the accepted write failed");
		});
	}
}

describe("overlapping imports of one move", () => {
	it("#given A checked before B landed the file and lost its accepted write #when A's bundle then fails verification #then the move is not failed and a re-run accepts it", async () => {
		const { base, cwdB, bundleDir, ledger, readIdentity } = await setup();
		const changed = join(base, "bundle-changed");
		cpSync(bundleDir, changed, { recursive: true });
		appendFileSync(join(changed, "files", "session.jsonl"), '{"changed":true}\n');
		const lossy = new LosesAcceptedWrite(ledger.dir);
		beforeVerify.set(changed, async () => {
			const b = importMovedSession({ bundleDir, targetCwd: cwdB, ledger: lossy, readIdentity });
			await expect(b).rejects.toThrow("the accepted write failed");
		});

		const a = importMovedSession({ bundleDir: changed, targetCwd: cwdB, ledger, readIdentity });
		await expect(a).rejects.toMatchObject({ code: "move_bundle_invalid" });

		expect(lossy.landed).toBeDefined();
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "receiving" });
		const again = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });
		expect(again.sessionFile).toBe(lossy.landed);
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "accepted" });
	});
});
