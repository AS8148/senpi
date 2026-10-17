import { join } from "node:path";
import type { ToolChildChannel } from "./channel.ts";
import { DescendantsLedger, LaunchLog } from "./descendants.ts";
import { defaultGroupProbes, type LedgeredGroup, type SweepOutcome, sweepGroups } from "./group-ownership.ts";
import { type BarrierViolation, LaunchEnforcer } from "./launch-enforcer.ts";
import type { ToolChildMessage } from "./protocol.ts";

export interface GenerationBarrier {
	readonly ledger: DescendantsLedger;
	readonly log: LaunchLog;
	handle(frame: ToolChildMessage): boolean;
	teardown(child: LedgeredGroup | undefined): Promise<SweepOutcome[]>;
}

export function createGenerationBarrier(options: {
	readonly dir: string;
	readonly generation: number;
	readonly channel: ToolChildChannel;
	readonly onViolation: (violation: BarrierViolation) => void;
	readonly holdAck?: (launchId: string) => Promise<void>;
}): GenerationBarrier {
	const ledger = new DescendantsLedger(join(options.dir, `g${options.generation}`, "descendants.ledger"));
	const log = new LaunchLog(join(options.dir, "launches.jsonl"));
	const enforcer = new LaunchEnforcer({
		generation: options.generation,
		ledger,
		log,
		sendAck: (launchId) => options.channel.send({ type: "launch_ack", launchId }),
		onViolation: options.onViolation,
		leaderStart: (pid) => defaultGroupProbes.startOf(pid),
		...(options.holdAck === undefined ? {} : { holdAck: options.holdAck }),
	});
	return {
		ledger,
		log,
		handle(frame) {
			switch (frame.type) {
				case "launch":
					void enforcer.onLaunch(frame);
					return true;
				case "launch_proof":
					enforcer.onProof(frame);
					return true;
				case "launch_done":
					enforcer.onDone(frame);
					return true;
				case "command_started":
				case "slot_state":
					void log.record({ ...frame });
					return true;
				default:
					return false;
			}
		},
		async teardown(child) {
			enforcer.dispose();
			const owned: LedgeredGroup[] = ledger.entries().flatMap((entry) =>
				entry.pgid === undefined
					? []
					: [
							{
								launchId: entry.launchId,
								pgid: entry.pgid,
								leaderStart: entry.leaderStart,
								lifetime: entry.lifetime,
							},
						],
			);
			const outcomes =
				process.platform === "win32"
					? []
					: await sweepGroups(child === undefined ? owned : [...owned, child], {
							graceMs: 2_000,
							killWaitMs: 2_000,
						});
			await log.record({
				type: "teardown",
				generation: options.generation,
				outcomes: outcomes.map((o) => `${o.launchId}:${o.verdict}`).join(","),
			});
			await log.settled();
			await ledger.remove();
			return outcomes;
		},
	};
}
