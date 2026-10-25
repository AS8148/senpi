import type { MrtrInputResponse } from "./elicitation.ts";
import { McpMrtrError } from "./errors.ts";

interface QueueJob {
	readonly signal: AbortSignal;
	readonly run: () => Promise<MrtrInputResponse>;
	readonly resolve: (value: MrtrInputResponse) => void;
	readonly reject: (error: unknown) => void;
	abort: () => void;
}
const queues = new WeakMap<object, { busy: boolean; jobs: QueueJob[] }>();
export function queuedForm(binding: object, signal: AbortSignal, run: QueueJob["run"]): Promise<MrtrInputResponse> {
	let queue = queues.get(binding);
	if (!queue) {
		queue = { busy: false, jobs: [] };
		queues.set(binding, queue);
	}
	const current = queue;
	const pump = () => {
		if (current.busy) return;
		const next = current.jobs.shift();
		if (!next) {
			queues.delete(binding);
			return;
		}
		next.signal.removeEventListener("abort", next.abort);
		if (next.signal.aborted) {
			next.reject(new McpMrtrError("MCP_MRTR_PROCESSING_UNAVAILABLE"));
			pump();
			return;
		}
		current.busy = true;
		void next
			.run()
			.then(next.resolve, next.reject)
			.finally(() => {
				current.busy = false;
				pump();
			});
	};
	return new Promise((resolve, reject) => {
		const job: QueueJob = { signal, run, resolve, reject, abort: () => {} };
		job.abort = () => {
			const index = current.jobs.indexOf(job);
			if (index >= 0) {
				current.jobs.splice(index, 1);
				signal.removeEventListener("abort", job.abort);
				reject(new McpMrtrError("MCP_MRTR_PROCESSING_UNAVAILABLE"));
			}
		};
		current.jobs.push(job);
		signal.addEventListener("abort", job.abort, { once: true });
		if (signal.aborted) job.abort();
		pump();
	});
}
