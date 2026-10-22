/**
 * Where a move lands (senpi#4004): the receiver's record keeps the target the first import claimed, so the move lands in
 * that one file only. Concurrent imports, an import after a lost `accepted` write, and a retry after the landed copy
 * was deleted all go through that one target.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultSessionDir, loadEntriesFromFile } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import { sessionOwnership } from "../../src/core/session-move/ownership.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";
import { devices, exportedForB, importedOnB, move } from "./rpc-move-session-support.ts";

const ledgerFile = (agentDir: string, moveId: string) => join(agentDir, "session-moves", "ledger", `${moveId}.json`);

describe("move_session lands a move in one file (senpi#4004)", () => {
	it("#given two imports of one move into different folders at once #then exactly one lands and the other is refused", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const bundleDir = await exportedForB(a, b, fixture, "move-l1");
		let arrived = 0;
		let bothArrived = (): void => {};
		const bothAtCommit = new Promise<void>((resolve) => {
			bothArrived = resolve;
		});
		let oneSettled: Promise<unknown> = bothAtCommit;
		// Forces the race without timing: a commit waits until the other import reached its commit too, or settled.
		class GatedLedger extends MoveLedger {
			override async commit<T>(...args: Parameters<MoveLedger["commit"]>): Promise<T> {
				arrived += 1;
				if (arrived === 2) bothArrived();
				await Promise.race([bothAtCommit, oneSettled]);
				return (super.commit as (...rest: unknown[]) => Promise<T>)(...args);
			}
		}
		const ledger = new GatedLedger(join(fixture.agentB, "session-moves", "ledger"));
		const into = (cwd: string) =>
			importMovedSession({
				bundleDir,
				targetCwd: cwd,
				ledger,
				sessionDir: getDefaultSessionDir(cwd, fixture.agentB),
				from: "device-a",
			});
		const imports = [into(fixture.repoB), into(fixture.repoA)];
		oneSettled = Promise.race(
			imports.map((done) =>
				done.then(
					() => undefined,
					() => undefined,
				),
			),
		);
		const results = await Promise.allSettled(imports);

		const landedFiles = results.flatMap((result) =>
			result.status === "fulfilled" ? [result.value.sessionFile] : [],
		);
		const refusals = results.flatMap((result) =>
			result.status === "rejected" ? [(result.reason as { code?: string }).code] : [],
		);
		expect(landedFiles).toHaveLength(1);
		expect(refusals).toEqual(["move_fenced"]);
		const name = basename(landedFiles[0] ?? "");
		const landed = [fixture.repoB, fixture.repoA].filter((cwd) =>
			existsSync(join(getDefaultSessionDir(cwd, fixture.agentB), name)),
		);
		expect(landed).toHaveLength(1);
	});

	it("#given the accepted write was lost (record left receiving) #when the bundle is imported into another folder #then it is refused and the landed copy is still accepted", async () => {
		const fixture = await devices();
		await using a = createInProcessRig(fixture.agentA);
		await using b = createInProcessRig(fixture.agentB);
		const onB = await importedOnB(a, b, fixture, "move-l2");
		const record = JSON.parse(readFileSync(ledgerFile(fixture.agentB, "move-l2"), "utf8")) as Record<string, unknown>;
		writeFileSync(ledgerFile(fixture.agentB, "move-l2"), `${JSON.stringify({ ...record, state: "receiving" })}\n`);
		const bundleDir = join(fixture.agentA, "session-moves", "outgoing", "move-l2");
		const elsewhere = join(getDefaultSessionDir(fixture.repoA, fixture.agentB), basename(onB));

		expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoA, from: "device-a" })).toMatchObject({
			success: false,
			error: "move_fenced",
		});
		expect(existsSync(elsewhere)).toBe(false);

		expect(await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" })).toMatchObject({
			success: true,
			data: { session_path: onB },
		});
		expect((await move(b, { op: "status", moveId: "move-l2" })).data).toEqual({ state: "accepted" });
	});

	for (const revoked of [false, true]) {
		it(`#given the landed copy was deleted${revoked ? " after a revoke" : ""} #when the same import is retried #then it ${revoked ? "is refused" : "lands again, writable"}`, async () => {
			const fixture = await devices();
			await using a = createInProcessRig(fixture.agentA);
			await using b = createInProcessRig(fixture.agentB);
			const moveId = revoked ? "move-l4" : "move-l3";
			const onB = await importedOnB(a, b, fixture, moveId);
			if (revoked) await move(b, { op: "revoke", sessionPath: onB, moveId });
			rmSync(onB);
			const bundleDir = join(fixture.agentA, "session-moves", "outgoing", moveId);

			const retried = await move(b, { op: "import", bundleDir, cwd: fixture.repoB, from: "device-a" });
			if (revoked) {
				expect(retried).toMatchObject({ success: false, error: "move_fenced" });
				expect(existsSync(onB)).toBe(false);
				return;
			}
			expect(retried).toMatchObject({ success: true, data: { session_path: onB } });
			expect(sessionOwnership(loadEntriesFromFile(onB)).writable).toBe(true);
			expect((await move(b, { op: "status", moveId })).data).toEqual({ state: "accepted" });
		});
	}
});
