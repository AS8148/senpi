#!/usr/bin/env node
// senpi-qa scenario for omo-desktop-app #2249 over the real `--mode rpc` surface.
//
// Holds auth.json's proper-lockfile directory from process start, asks for the model
// catalog while it is held, releases it, then asks `get_auth_providers`. It records
// whether the RPC read path reached the busy state: a run that never did cannot prove
// or disprove the fix, and fails that check instead of passing.
//
//   node .agents/skills/senpi-qa/scripts/scenarios/auth-status-busy-store-qa.mjs --self-test
//   node .agents/skills/senpi-qa/scripts/scenarios/auth-status-busy-store-qa.mjs --self-test --evidence auth-status-busy-store
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createChecks, evidenceDir, guardRealAuth, installCleanupHooks, makeSandbox } from "../lib/common.mjs";
import { hermeticEnv } from "../lib/mock-loop-support.mjs";
import { RpcClient } from "../lib/rpc-client.mjs";

const PROVIDER = "openai";
const argv = process.argv.slice(2);
const evidenceSlug = argv.includes("--evidence") ? argv[argv.indexOf("--evidence") + 1] : undefined;

const rowsFor = (response) => (response?.data?.providers ?? []).filter((row) => row.id === PROVIDER);

async function main() {
	installCleanupHooks();
	const realAuth = guardRealAuth();
	const box = makeSandbox("auth-status-busy-store");
	const authPath = join(box.agentDir, "auth.json");
	writeFileSync(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: "sk-qa-2249" } }));
	mkdirSync(`${authPath}.lock`);

	const checks = createChecks("#2249 auth status after a busy first credential read (RPC)");
	const rpc = new RpcClient({ env: hermeticEnv(box.env), cwd: box.cwd });
	const transcript = [];
	try {
		const locked = await rpc.send({ type: "get_available_models" }, { timeoutMs: 90000 });
		const lockedCount = (locked?.data?.models ?? []).filter((model) => model.provider === PROVIDER).length;
		const lockedAuth = await rpc.send({ type: "get_auth_providers" }, { timeoutMs: 45000 });
		transcript.push({ step: "auth while locked", rows: rowsFor(lockedAuth) });
		rmSync(`${authPath}.lock`, { recursive: true, force: true });
		const released = await rpc.send({ type: "get_auth_providers" }, { timeoutMs: 45000 });
		transcript.push({ step: "models while locked", providerModels: lockedCount });
		transcript.push({ step: "auth after release", rows: rowsFor(released) });

		checks.ok(
			"the locked first read reached the busy state on the real RPC path",
			lockedCount === 0,
			`${lockedCount} ${PROVIDER} models listed while auth.json was locked`,
		);
		const apiKeyRow = rowsFor(released).find((row) => row.authType === "api_key");
		checks.ok(
			"after release, the api_key row reports the stored credential",
			apiKeyRow?.status?.configured === true,
			JSON.stringify(apiKeyRow?.status ?? null),
		);
	} finally {
		rpc.child?.kill?.();
		rmSync(`${authPath}.lock`, { recursive: true, force: true });
		box.cleanup();
	}
	await checks.run("real auth.json unchanged", async () => realAuth.assertUnchanged() && "sha256 unchanged");

	if (evidenceSlug) {
		const dir = evidenceDir(evidenceSlug);
		writeFileSync(join(dir, "transcript.json"), `${JSON.stringify(transcript, null, 2)}\n`);
	}
	process.exitCode = checks.finish() ? 0 : 1;
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
