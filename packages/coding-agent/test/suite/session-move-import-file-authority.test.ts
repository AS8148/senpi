import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveFencedError, MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { customTypes, MOVE, setup } from "./session-move-fixture.ts";

class LosesAcceptedWrite extends MoveLedger {
	landed: string | undefined;

	constructor(
		dir: string,
		private readonly renames: boolean,
	) {
		super(dir);
	}

	override commit<T>(moveId: MoveId, rename: () => T | Promise<T>): Promise<T> {
		return super.commit(moveId, async () => {
			if (this.renames) this.landed = String(await rename());
			throw new Error("the accepted write failed");
		});
	}
}

describe("a re-run move import with the session file as the authority", () => {
	it("#given the accepted write failed after the rename #when the import runs again #then it returns the session and the ledger reads accepted", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const lossy = new LosesAcceptedWrite(ledger.dir, true);
		await expect(
			importMovedSession({ bundleDir, targetCwd: cwdB, ledger: lossy, readIdentity }),
		).rejects.toThrow("the accepted write failed");
		const landed = lossy.landed ?? "";
		expect(customTypes(landed).at(-1)).toBe("session_moved_in");
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({
			state: "failed",
			reason: "import_failed",
		});

		const again = await importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity });

		expect(again.sessionFile).toBe(landed);
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given the import failed before its rename #when it runs again #then the failed move is not accepted", async () => {
		const { cwdB, bundleDir, ledger, readIdentity } = await setup();
		const lossy = new LosesAcceptedWrite(ledger.dir, false);
		await expect(
			importMovedSession({ bundleDir, targetCwd: cwdB, ledger: lossy, readIdentity }),
		).rejects.toThrow("the accepted write failed");
		expect(lossy.landed).toBeUndefined();

		await expect(importMovedSession({ bundleDir, targetCwd: cwdB, ledger, readIdentity })).rejects.toBeInstanceOf(
			MoveFencedError,
		);
		expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual({
			state: "failed",
			reason: "import_failed",
		});
	});
});
