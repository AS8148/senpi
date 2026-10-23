/**
 * senpi#3695: a session on the worker runtime reads the same subscription limit records as an in-process one.
 * The host's poller feeds only the host's store; each isolate holds its own copy, so the host mirrors its
 * records into the worker (and the worker's turn reports back). Driven through the REAL worker registry.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { SubscriptionLimitStore, subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { WorkerSessionRegistry } from "../../../src/modes/rpc/worker-session-registry.ts";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

it("a worker-runtime session reads the host's polled limits before its first turn", async () => {
	const host = await startWorkerHost();
	const out = join(host.scratch, "limits.json");
	const extension = join(host.scratch, "read-limits.mjs");
	await writeFile(
		extension,
		`import { writeFileSync } from "node:fs";
export default function (pi) {
	writeFileSync(${JSON.stringify(out)}, JSON.stringify(pi.getSubscriptionLimits()));
}`,
	);
	const account = `worker-3695-${process.pid}`;
	subscriptionLimits.report("anthropic-subscription", account, {
		windows: [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 41 }],
		plan: "max",
		reportedAt: new Date("2026-10-23T10:00:00Z"),
	});
	const registry = new WorkerSessionRegistry({
		configuration: {
			parsed: parseArgs([
				"--mode",
				"rpc",
				"--no-extensions",
				"--no-skills",
				"--no-context-files",
				"--extension",
				extension,
			]),
			cwd: host.cwd,
			agentDir: join(host.scratch, "agent"),
			appMode: "rpc",
		},
		closeGraceMs: 1000,
		now: Date.now,
	});
	let sessionId: string | undefined;
	try {
		const opened = await registry.openSession({ cwd: host.cwd });
		sessionId = opened.sessionId;
		const seen = JSON.parse(await readFile(out, "utf8")) as { account: string; plan?: string }[];

		expect(seen.find((limits) => limits.account === account)).toMatchObject({
			provider: "anthropic-subscription",
			plan: "max",
			windows: [{ id: "claude:5h", usedPercent: 41 }],
		});
	} finally {
		if (sessionId) await registry.close(sessionId).catch(() => undefined);
		await host.dispose();
	}
}, 60_000);

it("a mirrored record that comes straight back is not published again", () => {
	const store = new SubscriptionLimitStore();
	const published: string[] = [];
	store.subscribe((limits) => published.push(limits.reportedAt));
	const record = {
		provider: "anthropic-subscription",
		account: "work",
		windows: [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 12 }],
		reportedAt: "2026-10-23T10:00:00.000Z",
	};

	store.adopt(record);
	store.adopt({ ...record });
	store.adopt({ ...record, reportedAt: "2026-10-23T09:00:00.000Z" });

	expect(published).toEqual(["2026-10-23T10:00:00.000Z"]);
});

// Two different records with the same reportedAt (report() keeps the previous reportedAt when only the
// error changes) must settle on one value whatever order they arrive in, or host and worker bounce them.
const tiedErrors = () => {
	const base = {
		provider: "anthropic-subscription",
		account: "work",
		windows: [{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 12 }],
		reportedAt: "2026-10-23T10:00:00.000Z",
	};
	return [
		{ ...base, error: "rate limited" },
		{ ...base, error: "sign-in needed" },
	] as const;
};

it("records tied on reportedAt settle on the same value in either arrival order", () => {
	const [first, second] = tiedErrors();
	const forward = new SubscriptionLimitStore();
	const backward = new SubscriptionLimitStore();

	forward.adopt(first);
	forward.adopt(second);
	backward.adopt(second);
	backward.adopt(first);

	expect(forward.snapshot()).toEqual(backward.snapshot());
});

it("a crossed pair of tied records between two mirrored stores stops echoing", () => {
	const [first, second] = tiedErrors();
	const host = new SubscriptionLimitStore();
	const worker = new SubscriptionLimitStore();
	const toWorker: (typeof first | typeof second)[] = [];
	const toHost: (typeof first | typeof second)[] = [];
	host.subscribe((limits) => toWorker.push(structuredClone(limits) as typeof first));
	worker.subscribe((limits) => toHost.push(structuredClone(limits) as typeof first));

	host.adopt(first);
	host.adopt(second);
	let deliveries = 0;
	while ((toWorker.length > 0 || toHost.length > 0) && deliveries < 100) {
		const next = toWorker.shift();
		if (next !== undefined) worker.adopt(next);
		const back = toHost.shift();
		if (back !== undefined) host.adopt(back);
		deliveries += 1;
	}

	expect(deliveries).toBeLessThan(100);
	expect(host.snapshot()).toEqual(worker.snapshot());
});
