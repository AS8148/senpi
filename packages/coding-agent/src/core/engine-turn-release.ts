import type { EngineTurnHold } from "./engine-turn-hold.ts";
import type { CustomMessage } from "./messages.ts";

/** Never uses the native follow-up queue: its `all` mode may combine unrelated sources. */
export class EngineTurnRelease {
	private running: Promise<void> | undefined;

	resume(
		hold: EngineTurnHold,
		sendThroughAgentEnd: (message: CustomMessage) => Promise<void>,
		releaseSources: (sources: Record<string, number>) => Promise<void>,
	): Promise<void> {
		if (this.running) return this.running;
		if (!hold.held) return Promise.resolve();
		const sources = hold.sources;
		const generation = hold.generation;
		const run = async () => {
			for (const { source, message } of hold.messages()) {
				if (hold.generation !== generation) return;
				// sendCustomMessage resolves only after the run's agent_end handlers settle.
				await sendThroughAgentEnd(message);
				if (hold.generation !== generation) return;
				hold.consume(source);
			}
			if (hold.generation !== generation) return;
			hold.releaseAll("resume_session");
			const remaining = hold.finish();
			await releaseSources({ ...sources, ...remaining });
		};
		this.running = run().finally(() => {
			this.running = undefined;
		});
		return this.running;
	}
}
