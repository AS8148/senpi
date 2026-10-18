/**
 * Cleanup for launches whose server went away (senpi#3566 todo 4; review HIGH 2). The ledger is fsynced before every
 * ack, so it names every owned group even when its writer is dead: a child that loses its host sweeps them before it
 * exits, and a server starting a session sweeps whatever a crashed predecessor left before it writes a new ledger.
 * Detached launches are never touched; the identity check in `sweepGroups` keeps a reused pgid safe.
 */
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DescendantsLedger, generationLedgerPath } from "./descendants.ts";
import { type LedgeredGroup, type SweepOutcome, sweepGroups } from "./group-ownership.ts";

const SWEEP_TIMING = { graceMs: 500, killWaitMs: 1_000 } as const;

/** Sweeps the owned groups one ledger names. */
export async function sweepLedger(path: string): Promise<SweepOutcome[]> {
	const groups: LedgeredGroup[] = (await DescendantsLedger.readPersisted(path)).flatMap((entry) =>
		entry.pgid === undefined
			? []
			: [{ launchId: entry.launchId, pgid: entry.pgid, leaderStart: entry.leaderStart, lifetime: entry.lifetime }],
	);
	return groups.length === 0 ? [] : sweepGroups(groups, SWEEP_TIMING);
}

/** Sweeps and removes every generation ledger left in a session's tool-child directory. */
export async function sweepStaleGenerations(dir: string): Promise<SweepOutcome[]> {
	const names = await readdir(dir).catch(() => [] as string[]);
	const outcomes: SweepOutcome[] = [];
	for (const name of names) {
		const generation = /^g(\d+)$/.exec(name)?.[1];
		if (generation === undefined) continue;
		outcomes.push(...(await sweepLedger(generationLedgerPath(dir, Number(generation)))));
		await rm(join(dir, name), { recursive: true, force: true });
	}
	return outcomes;
}
