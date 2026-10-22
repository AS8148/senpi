#!/usr/bin/env node
// Real-CLI QA for the sealed RPC internal hop (senpi#3795/#3816): starts a supervised socket host from the built CLI in
// an isolated sandbox, drives get_protocol_info and list_sessions through the sealed hop, checks the hop directory and
// its frame-5 refusal, then SIGKILLs the supervisor and asserts its host child ends.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	cleanupAll,
	createChecks,
	evidenceDir,
	guardRealAuth,
	installCleanupHooks,
	makeSandbox,
	repoRoot,
} from "../lib/common.mjs";

const HOP_PREFIX = "senpi-rpc-host-internal-";

function listProcesses() {
	return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
		.filter(Boolean)
		.map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
}

/** Finds the host's internal hop: the first hop directory under the temp roots that a running host listens on. */
export function locateHop({ roots = [tmpdir(), "/tmp"] } = {}) {
	const processes = listProcesses();
	const hops = roots.flatMap((root) => {
		try {
			return readdirSync(root).filter((name) => name.startsWith(HOP_PREFIX)).map((name) => join(root, name));
		} catch {
			return [];
		}
	});
	const hop = hops.find((dir) => processes.some((p) => p.command.includes(dir)));
	const child = hop && processes.find((p) => p.command.includes(`unix://${join(hop, "host.sock")}`));
	return child ? { hop, childPid: child.pid, supervisorPid: child.ppid } : undefined;
}

export function stopSupervisor({ supervisorPid, signal = "SIGKILL" }) {
	process.kill(supervisorPid, signal);
	return true;
}

async function runQa() {
	installCleanupHooks();
	const auth = guardRealAuth();
	const box = makeSandbox("hopqa");
	const out = evidenceDir("rpc-internal-hop");
	const sock = join(box.dir, "h.sock");
	// A sandbox-private TMPDIR puts the host's internal hop inside this run's sandbox.
	const sandboxTmp = join(box.dir, "t");
	mkdirSync(sandboxTmp);
	box.env.TMPDIR = sandboxTmp;
	const expectedVersion = JSON.parse(readFileSync(join(repoRoot(), "packages/coding-agent/package.json"), "utf8")).version;
	const checks = createChecks("sealed internal hop");
	// The built CLI: source-through-tsx startup can exceed the fixed 10 s readiness wait under load.
	const cli = join(repoRoot(), "packages/coding-agent/dist/cli.js");
	const runBuilt = (args) =>
		new Promise((resolve) =>
			execFile(process.execPath, [cli, ...args], { env: box.env, cwd: box.cwd, timeout: 120_000 }, (error, stdout, stderr) =>
				resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }),
			),
		);
	const show = (value) => String(JSON.stringify(value) ?? "none").slice(0, 200);
	const log = [];
	const note = (k, v) => log.push({ k, v });
	try {
		const ensured = await runBuilt(["host", "ensure", "--socket", sock, "--json"]);
		note("ensure", { code: ensured.code, stdout: ensured.stdout.trim(), stderr: ensured.stderr.trim().slice(-2000) });
		if (!checks.ok("host ensure exits 0", ensured.code === 0, ensured.stdout.trim().slice(0, 300)))
			throw new Error("host did not start");
		const ensuredPayload = JSON.parse(ensured.stdout.trim().split("\n").at(-1));
		const info = await request(sock, [
			{ id: "q1", type: "get_protocol_info" },
			{ id: "q2", type: "list_sessions" },
		]);
		note("public", info.lines);
		checks.ok("get_protocol_info answers through the sealed hop", info.lines[0]?.success === true, show(info.lines[0]));
		checks.ok("list_sessions answers through the sealed hop", info.lines[1]?.success === true, show(info.lines[1]));
		const target = locateHop({ supervisorPid: ensuredPayload.pid, sandboxTmp });
		const owned =
			target !== undefined &&
			info.lines[0]?.data?.serverVersion === expectedVersion &&
			typeof ensuredPayload.instanceId === "string";
		note("target", { expectedVersion, instanceId: ensuredPayload.instanceId, ...target });
		if (!checks.ok("targets are this run's own supervisor and host", owned))
			throw new Error("refusing to touch processes that this run did not start");
		const { hop, childPid, supervisorPid } = target;
		checks.ok("the hop directory holds the socket and owner record", existsSync(join(hop, "host.sock")) && existsSync(join(hop, ".owner")));
		checks.ok("no key or secret file on disk", !readdirSync(hop).some((f) => /secret|key/i.test(f)), JSON.stringify(readdirSync(hop)));
		checks.ok("the host child runs under the supervisor", alive(childPid) && alive(supervisorPid));
		const raw = await request(join(hop, "host.sock"), [{ id: "raw", type: "get_protocol_info" }]);
		note("rawInternal", raw);
		checks.ok(
			"an unauthenticated internal connection is answered auth_required, then closed",
			raw.closed && raw.lines.length === 1 && raw.lines[0].error === "auth_required" && raw.lines[0].command === "get_protocol_info",
			JSON.stringify(raw.lines),
		);
		stopSupervisor({ supervisorPid, sandboxPath: box.dir, sock, signal: "SIGKILL" });
		const exited = await waitForExit(childPid, 15_000);
		note("afterSupervisorKill", { childExited: exited });
		checks.ok("SIGKILL of the supervisor ends the host child", exited);
		checks.ok("real auth.json unchanged", auth.assertUnchanged());
	} catch (cause) {
		checks.ok("qa ran without an exception", false, String(cause?.stack ?? cause));
	} finally {
		writeFileSync(join(out, "hop-qa-log.json"), `${JSON.stringify(log, null, 2)}\n`);
		cleanupAll();
		box.cleanup();
	}
	const ok = checks.finish();
	process.stdout.write(`sha256 ${createHash("sha256").update(readFileSync(join(out, "hop-qa-log.json"))).digest("hex")}  hop-qa-log.json\n`);
	process.exitCode = ok ? 0 : 1;
}

function request(path, frames) {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		const lines = [];
		let buffer = "";
		const timer = setTimeout(() => {
			socket.destroy();
			resolve({ lines, closed: false });
		}, 20_000);
		socket.on("data", (data) => {
			buffer += data.toString();
			for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
				lines.push(JSON.parse(buffer.slice(0, i)));
				buffer = buffer.slice(i + 1);
				if (lines.length < frames.length) socket.write(`${JSON.stringify(frames[lines.length])}\n`);
				else socket.end();
			}
		});
		socket.on("close", () => {
			clearTimeout(timer);
			resolve({ lines, closed: true });
		});
		socket.on("error", () => {});
		socket.on("connect", () => socket.write(`${JSON.stringify(frames[0])}\n`));
	});
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return cause.code !== "ESRCH";
	}
}

async function waitForExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (alive(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
	return !alive(pid);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	if (process.argv.includes("--self-test") || process.argv.includes("--run")) await runQa();
	else process.stdout.write("usage: rpc-internal-hop-qa.mjs --self-test   (needs a built packages/coding-agent/dist)\n");
}
