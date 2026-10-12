import { afterEach, describe, expect, it } from "vitest";
import { dataOf, type RawClient, statusHost, statusRecords, type WireRecord } from "./rpc-session-status-support.ts";

const hosts: Array<AsyncDisposable> = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host[Symbol.asyncDispose]();
});

async function host() {
	const created = await statusHost();
	hosts.push(created);
	return created;
}

async function subscribe(client: RawClient, fields: Record<string, unknown> = {}) {
	const data = dataOf(await client.request({ type: "subscribe_sessions", ...fields }));
	return {
		subscriptionId: String(data.subscriptionId),
		snapshot: data.snapshot as WireRecord[],
		seq: Number(data.seq),
	};
}

function nextStatus(client: RawClient, subscriptionId: string, cause: string, sessionId?: string) {
	return client.waitFor(
		(record) =>
			record.type === "session_status" &&
			record.subscriptionId === subscriptionId &&
			(record.lastChange as { cause?: string } | undefined)?.cause === cause &&
			(sessionId === undefined || record.sessionId === sessionId),
	);
}

describe("session_status stream (T1 acceptance)", () => {
	it("delivers open, set_model, queue, abort, replace, a second open and a detach to an unattached subscriber in order", async () => {
		const rig = await host();
		const a = rig.client("A");
		const b = rig.client("B");
		const c = rig.client("C");

		// Given: B is subscribed to every session and never attaches to any.
		const sub = await subscribe(b);
		expect(sub.snapshot).toEqual([]);
		expect(sub.seq).toBe(0);

		// When: A opens rpc-1, C and A2 attach to it, then A drives it.
		const opened = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s1 = String(opened.sessionId);
		const firstPath = String((opened.state as { sessionFile?: string }).sessionFile);
		await nextStatus(b, sub.subscriptionId, "open", s1);
		dataOf(await c.request({ type: "open_session", cwd: rig.cwd, sessionPath: firstPath }));
		await nextStatus(b, sub.subscriptionId, "attach", s1);
		const third = rig.client("A2");
		dataOf(await third.request({ type: "open_session", cwd: rig.cwd, sessionPath: firstPath }));
		const attached3 = await b.waitFor(
			(record) =>
				record.type === "session_status" &&
				record.subscriptionId === sub.subscriptionId &&
				record.attachments === 3,
		);
		expect(attached3.lastChange).toMatchObject({ cause: "attach" });

		dataOf(await a.request({ type: "set_model", sessionId: s1, provider: rig.model.provider, modelId: "faux-b" }));
		const modelStatus = await nextStatus(b, sub.subscriptionId, "set_model", s1);
		expect(modelStatus.model).toEqual({ provider: rig.model.provider, id: "faux-b" });

		dataOf(await a.request({ type: "steer", sessionId: s1, message: "queued steer" }));
		const queued = await nextStatus(b, sub.subscriptionId, "queue", s1);
		expect(queued.pendingQueue).toMatchObject({ steering: 1 });

		dataOf(await a.request({ type: "abort", sessionId: s1 }));
		const aborted = await nextStatus(b, sub.subscriptionId, "abort", s1);
		expect(aborted).toMatchObject({ status: "idle", reason: "aborted" });

		const durableBefore = attached3.durableSessionId;
		dataOf(await a.request({ type: "new_session", sessionId: s1 }));
		const replaced = await nextStatus(b, sub.subscriptionId, "replace", s1);
		expect(replaced.sessionId).toBe(s1);
		expect(replaced.durableSessionId).not.toBe(durableBefore);

		const second = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s2 = String(second.sessionId);
		const openedRecord = await b.waitFor((record) => record.type === "session_opened" && record.sessionId === s2);
		expect(openedRecord).toMatchObject({ kind: "interactive", cwd: rig.cwd });
		await nextStatus(b, sub.subscriptionId, "open", s2);

		dataOf(await a.request({ type: "close_session", sessionId: s1 }));
		const detached = await nextStatus(b, sub.subscriptionId, "detach", s1);
		expect(detached.attachments).toBe(2);

		// Then: B saw every change in that order, never attached, with seq strictly +1 from the snapshot.
		const records = statusRecords(b, sub.subscriptionId);
		expect(records.map((record) => record.seq)).toEqual(records.map((_, index) => sub.seq + index + 1));
		const causes = records.map((record) => `${(record.lastChange as { cause: string }).cause}@${record.sessionId}`);
		const order = [
			`open@${s1}`,
			`set_model@${s1}`,
			`queue@${s1}`,
			`abort@${s1}`,
			`replace@${s1}`,
			`open@${s2}`,
			`detach@${s1}`,
		];
		let cursor = -1;
		for (const expected of order) {
			const index = causes.indexOf(expected, cursor + 1);
			expect(index, `${expected} after ${causes.slice(0, cursor + 1).join(",")}`).toBeGreaterThan(cursor);
			cursor = index;
		}
		const listed = dataOf(await b.request({ type: "list_sessions" })).sessions as Array<{
			sessionId: string;
			attachments: number;
		}>;
		expect(listed.find((row) => row.sessionId === s1)?.attachments).toBe(2);
	});

	it("emits the status AFTER the record that caused it on a connection that is also attached", async () => {
		const rig = await host();
		const a = rig.client("A");
		const opened = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s1 = String(opened.sessionId);
		const sub = await subscribe(a);
		dataOf(await a.request({ type: "steer", sessionId: s1, message: "queued" }));
		const status = await nextStatus(a, sub.subscriptionId, "queue", s1);
		const queueIndex = a.inbox.findIndex((record) => record.type === "queue_update" && record.sessionId === s1);
		expect(queueIndex).toBeGreaterThanOrEqual(0);
		expect(a.inbox.indexOf(status)).toBeGreaterThan(queueIndex);
	});

	it("matches a worker opened later under childrenOf by context.parent_session_id", async () => {
		const rig = await host();
		const parent = rig.client("parent");
		const watcher = rig.client("watcher");
		const sub = await subscribe(watcher, { sessions: { childrenOf: "parent-durable" } });
		const other = dataOf(await parent.request({ type: "open_session", cwd: rig.cwd, kind: "worker" }));
		const child = dataOf(
			await parent.request({
				type: "open_session",
				cwd: rig.cwd,
				kind: "worker",
				context: { parent_session_id: "parent-durable", task_id: "t1" },
			}),
		);
		const opened = await watcher.waitFor((record) => record.type === "session_opened" && record.sessionId === child.sessionId);
		expect(opened.kind).toBe("worker");
		await nextStatus(watcher, sub.subscriptionId, "open", String(child.sessionId));
		expect(watcher.inbox.some((record) => record.sessionId === other.sessionId)).toBe(false);

		dataOf(await parent.request({ type: "close_session", sessionId: child.sessionId }));
		const ended = await nextStatus(watcher, sub.subscriptionId, "close", String(child.sessionId));
		expect(ended).toMatchObject({ status: "closed", reason: "client_close", kind: "worker" });
		expect(watcher.inbox.some((record) => record.type === "session_closed")).toBe(false);
	});
});

describe("activity neutrality and mirror opt-in", () => {
	it("a subscriber-only connection never counts as an attachment nor refreshes the idle window", async () => {
		const rig = await host();
		const a = rig.client("A");
		const b = rig.client("B");
		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const row = async () =>
			(dataOf(await b.request({ type: "list_sessions" })).sessions as Array<{ sessionId: string; attachments: number; idleMs: number }>).find(
				(listed) => listed.sessionId === s1,
			);
		const before = await row();
		rig.clock.now += 5_000;
		await subscribe(b, { mirror: "all" });
		await b.request({ type: "unsubscribe_sessions", subscriptionId: "sub-missing" });
		rig.clock.now += 5_000;
		const after = await row();
		expect(after?.attachments).toBe(before?.attachments);
		expect(after?.idleMs).toBe((before?.idleMs ?? 0) + 10_000);
	});

	it("mirrors only the opted-in content kinds, never to a subscriber without mirror, worker content only with include_workers", async () => {
		const rig = await host();
		const a = rig.client("A");
		const mirror = rig.client("mirror");
		const statusOnly = rig.client("statusOnly");
		const interactiveOnly = rig.client("interactiveOnly");
		const sub = await subscribe(mirror, {
			sessions: "all",
			include_workers: true,
			mirror: ["message_update", "tool_execution_start"],
		});
		await subscribe(statusOnly);
		await subscribe(interactiveOnly, { mirror: "all", include_workers: false });

		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd })).sessionId);
		const worker = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd, kind: "worker" })).sessionId);
		rig.faux.setResponses([
			{ role: "assistant", content: [{ type: "text", text: "interactive reply" }], api: rig.faux.api, provider: rig.model.provider, model: rig.model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ls", arguments: { path: "." } }], api: rig.faux.api, provider: rig.model.provider, model: rig.model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 0 },
			{ role: "assistant", content: [{ type: "text", text: "worker done" }], api: rig.faux.api, provider: rig.model.provider, model: rig.model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 },
		]);
		const idle1 = a.waitFor((record) => record.type === "agent_idle" && record.sessionId === s1);
		dataOf(await a.request({ type: "prompt", sessionId: s1, message: "hello" }));
		await idle1;
		const idle2 = a.waitFor((record) => record.type === "agent_idle" && record.sessionId === worker);
		dataOf(await a.request({ type: "prompt", sessionId: worker, message: "list" }));
		await idle2;
		await rig.writer.flush();

		expect(mirror.inbox.some((record) => record.type === "message_update" && record.sessionId === s1)).toBe(true);
		expect(mirror.inbox.some((record) => record.type === "tool_execution_start" && record.sessionId === worker)).toBe(true);
		expect(mirror.inbox.some((record) => record.type === "message_start")).toBe(false);
		expect(statusOnly.inbox.some((record) => record.type === "message_update" || record.type === "tool_execution_start")).toBe(false);
		expect(interactiveOnly.inbox.some((record) => record.type === "message_update" && record.sessionId === s1)).toBe(true);
		expect(interactiveOnly.inbox.some((record) => record.sessionId === worker && record.type !== "agent_start" && record.type !== "agent_settled" && record.type !== "agent_idle")).toBe(false);
		const listed = (dataOf(await mirror.request({ type: "list_sessions", include_workers: true })).sessions as Array<{ sessionId: string; attachments: number }>);
		expect(listed.find((row) => row.sessionId === s1)?.attachments).toBe(1);
		expect(statusRecords(mirror, sub.subscriptionId).length).toBeGreaterThan(0);
	});
});

describe("set_session_context and error copy", () => {
	it("patches context, republishes it to include_context subscribers and refuses reserved keys with reason and action", async () => {
		const rig = await host();
		const a = rig.client("A");
		const watcher = rig.client("watcher");
		const s1 = String(dataOf(await a.request({ type: "open_session", cwd: rig.cwd, kind: "worker" })).sessionId);
		const sub = await subscribe(watcher, { include_workers: true, include_context: true });
		const patched = dataOf(await a.request({ type: "set_session_context", sessionId: s1, patch: { task_status: "running", run_epoch: 2 } }));
		expect(patched.context).toMatchObject({ task_status: "running", run_epoch: 2 });
		const status = await nextStatus(watcher, sub.subscriptionId, "context", s1);
		expect(status.context).toMatchObject({ task_status: "running" });

		const refused = await a.request({ type: "set_session_context", sessionId: s1, patch: { host_socket: "/elsewhere" } });
		expect(refused).toMatchObject({ success: false, errorCode: "invalid_session_context" });
		expect(String(refused.error)).toBe('invalid_session_context: key "host_socket" is set by the host and cannot be patched');
		expect(refused.errorData).toEqual({
			reason: 'key "host_socket" is set by the host and cannot be patched',
			action: "drop that key from the patch; the host keeps it current",
		});

		const outsider = await watcher.request({ type: "set_session_context", sessionId: s1, patch: { a: "b" } });
		expect(outsider.errorData).toEqual({
			reason: "this connection is not attached to that session",
			action: "attach first with open_session { sessionPath }, then patch its context",
		});
		const badSub = await watcher.request({ type: "subscribe_sessions", sessions: { ids: [] } });
		expect(badSub).toMatchObject({ success: false, errorCode: "invalid_subscription" });
		expect((badSub.errorData as { action: string }).action).toContain("send sessions:");
		const unknown = await watcher.request({ type: "unsubscribe_sessions", subscriptionId: "nope" });
		expect(unknown.errorData).toEqual({
			reason: "this connection holds no subscription with that id",
			action: "send the subscriptionId your subscribe_sessions answer returned, on the same connection",
		});
		const rows = dataOf(await watcher.request({ type: "list_sessions", include_workers: true })).sessions as Array<{ sessionId: string; context: Record<string, unknown> }>;
		expect(rows.find((row) => row.sessionId === s1)?.context).toMatchObject({ task_status: "running", run_epoch: 2 });
	});
});

describe("F13: loaded_surfaces_changed dedupe", () => {
	it("tells a connection attached to several sessions about one inventory change once", async () => {
		const rig = await host();
		const a = rig.client("A");
		const s1 = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const s2 = dataOf(await a.request({ type: "open_session", cwd: rig.cwd }));
		const before = a.inbox.length;
		const snapshot = { servers: [{ name: "probe", serverInfo: null, tools: [], resources: [], resourceTemplates: [], authStatus: "unsupported" }] };
		for (const durable of [s1, s2].map((opened) => String((opened.state as { sessionId: string }).sessionId))) {
			rig.extensionApis.get(durable)?.events.emit("senpi.rpc.mcp_inventory.changed", { sessionId: durable, snapshot });
		}
		await rig.writer.flush();
		const changes = a.inbox.slice(before).filter((record) => record.type === "loaded_surfaces_changed");
		expect(changes).toHaveLength(1);
	});
});
