import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../../../../packages/coding-agent/src/modes/rpc/rpc-client.ts";
import { guardRealAuth, installCleanupHooks, makeSandbox, spawnCli, track } from "./lib/common.mjs";

// Two command-line client processes use the shipped transport against one real CLI host.
if (process.argv[2] === "--client") {
	const client = new RpcClient({ socketPath: process.argv[3] });
	await client.start();
	const lines = createInterface({ input: client.socket });
	lines.on("line", (line) => process.send({ kind: "wire", record: JSON.parse(line) }));
	process.on("message", async (message) => {
		try {
			if (message.kind === "stop") {
				lines.close();
				await client.stop();
				process.disconnect();
				return;
			}
			const response = await client.send(message.command, false);
			process.send({ kind: "reply", id: message.id, response });
		} catch (error) {
			process.send({ kind: "error", id: message.id, error: String(error) });
		}
	});
	process.send({ kind: "ready" });
} else {
	installCleanupHooks();
	const out = process.argv[2];
	assert(out, "usage: node --import tsx attachment-two-client-qa.mjs <evidence-dir>");
	mkdirSync(out, { recursive: true });
	const guard = guardRealAuth();
	const box = makeSandbox("rpc-attach-two-client");
	const transcript = [];
	const clients = [];
	let stderr = "";
	const socket = join(box.dir, "host.sock");
	const host = spawnCli(
		["--mode", "rpc", "--multi-session", "--listen", socket, "--session-runtime", "in-process",
			"--no-extensions", "--no-skills", "--no-context-files"],
		{ env: box.env, cwd: box.cwd },
	);
	const hostExit = once(host, "close");
	const ready = new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`host readiness deadline: ${stderr}`)), 60_000);
		host.stderr.on("data", (data) => {
			stderr += data.toString();
			if (stderr.includes("senpi rpc listening on")) {
				clearTimeout(timer);
				resolve();
			}
		});
		host.once("error", reject);
	});
	async function connect(name) {
		const child = track(fork(fileURLToPath(import.meta.url), ["--client", socket], {
			cwd: box.cwd, env: box.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
			execArgv: ["--import", import.meta.resolve("tsx")],
		}));
		const exit = once(child, "close");
		const pending = new Map();
		const records = [];
		let serial = 0;
		let readyResolve;
		const started = new Promise((resolve) => { readyResolve = resolve; });
		child.stdout.resume();
		child.stderr.on("data", (data) => { stderr += `${name}: ${data}`; });
		child.on("message", (message) => {
			if (message.kind === "ready") readyResolve();
			if (message.kind === "wire") {
				records.push(message.record);
				transcript.push({ client: name, direction: "receive", record: message.record });
			}
			const waiter = pending.get(message.id);
			if (!waiter) return;
			clearTimeout(waiter.timer);
			pending.delete(message.id);
			if (message.kind === "error") waiter.reject(new Error(message.error));
			else waiter.resolve(message.response);
		});
		const deadline = setTimeout(() => { child.kill("SIGKILL"); }, 60_000);
		try {
			await Promise.race([started, exit.then(() => { throw new Error(`${name} exited before ready`); })]);
		} finally {
			clearTimeout(deadline);
		}
		const client = {
			records,
			send(command) {
				transcript.push({ client: name, direction: "send", command });
				const id = ++serial;
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} request deadline`)); }, 60_000);
					pending.set(id, { resolve, reject, timer });
					child.send({ kind: "request", id, command });
				});
			},
			async stop() {
				if (child.exitCode !== null) return;
				const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
				child.send({ kind: "stop" });
				try { await exit; } finally { clearTimeout(timer); }
			},
		};
		clients.push(client);
		return client;
	}
	try {
		await ready;
		const a = await connect("A");
		const b = await connect("B");
		const protocol = await a.send({ type: "get_protocol_info" });
		assert.equal(protocol.success, true);
		const refs = [];
		for (const client of [a, b]) {
			const opened = await client.send({ type: "open_session", cwd: box.cwd, retain_on_disconnect: true });
			assert.equal(opened.success, true);
			const ref = {
				sessionId: opened.data.sessionId, sessionPath: opened.data.state.sessionFile,
				durableSessionId: opened.data.state.sessionId, expectedHostInstance: protocol.data.instanceId,
			};
			refs.push(ref);
			const attached = await client.send({ type: "attach_session", ...ref });
			assert.deepEqual(attached.data, { sessionId: ref.sessionId, attached: true });
			const released = await client.send({ type: "release_attachment", sessionId: ref.sessionId });
			assert.deepEqual(released.data, { deferred: false });
		}
		const beforeA = a.records.length;
		const beforeB = b.records.length;
		assert.deepEqual((await a.send({ type: "reclaim_session", ...refs[0] })).data,
			{ reclaimed: true, sessionId: refs[0].sessionId });
		const listed = await b.send({ type: "list_sessions" });
		assert.deepEqual(listed.data.sessions.map(({ sessionId, status, attachments }) => ({ sessionId, status, attachments })),
			[{ sessionId: refs[1].sessionId, status: "open", attachments: 1 }]);
		assert.equal(a.records.slice(beforeA).filter((record) => record.type === "response" && record.command === "close_session").length, 0);
		assert.equal(b.records.slice(beforeB).filter((record) =>
			["session_closed", "session_parked", "agent_end"].includes(record.type) ||
			(record.type === "response" && record.command === "close_session")).length, 0);
		assert.deepEqual((await b.send({ type: "reclaim_session", ...refs[1] })).data,
			{ reclaimed: true, sessionId: refs[1].sessionId });
		assert.deepEqual((await b.send({ type: "list_sessions" })).data.sessions, []);
		guard.assertUnchanged();
		writeFileSync(join(out, "summary.json"), `${JSON.stringify({
			pass: true, clients: 2, hosts: 1, attach: 2, release: 2, reclaim: 2,
			unrelatedSessionPreserved: true, strayCloseResponses: 0, authUnchanged: true,
		}, null, 2)}\n`);
		console.log("PASS two real CLI client processes: attach=2 release=2 reclaim=2; B remains open/attached; stray close/end=0");
	} finally {
		for (const client of clients) await client.stop();
		host.kill("SIGTERM");
		const timer = setTimeout(() => host.kill("SIGKILL"), 10_000);
		try { await hostExit; } finally { clearTimeout(timer); }
		box.cleanup();
		guard.assertUnchanged();
		writeFileSync(join(out, "transcript.jsonl"), `${transcript.map((record) => JSON.stringify(record)).join("\n")}\n`);
		writeFileSync(join(out, "host.stderr.log"), stderr);
		for (const name of ["transcript.jsonl", "host.stderr.log", "summary.json"]) {
			try {
				const hash = createHash("sha256").update(readFileSync(join(out, name))).digest("hex");
				console.log(`${hash}  ${name}`);
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}
	}
}
