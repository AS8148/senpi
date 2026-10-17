#!/usr/bin/env bun
/**
 * Real-surface QA scenario driver for the tool-child runtime (senpi#3566).
 *
 * Usage: bun scripts/qa-rpc-socket/tool-child-qa.mjs [--runtime in-process|child] --scenario <id>
 *          [--inject A,B:v] [--env K=V ...] [--extension test/fixtures/qa-tools-extension.ts]
 *          [--expect-failure <code>] --out <dir>
 *
 * Exit codes: 0 pass (or the expected failure was observed and recorded), 1 failed assertion,
 * `record_timeout` or any other outcome, 2 usage error or unknown scenario, 3 `prerequisite_missing`
 * (the host does not advertise a capability the scenario's `requires` names). Evidence goes to
 * `<out>/<scenario>.jsonl` and `<out>/<scenario>.json`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startMockModel } from "./lib/mock-model.mjs";
import { injectEnv, parseQaArgs } from "./lib/qa-args.mjs";
import { createControl } from "./lib/qa-control.mjs";
import { EXIT, QaFailure } from "./lib/qa-failure.mjs";
import { MOCK_MODEL, MOCK_PROVIDER, startQaHost, writeSandboxAgentDir } from "./lib/qa-host.mjs";
import { awaitRecord, createScenarioLog } from "./lib/qa-records.mjs";
import { SCENARIOS, unmetRequirements } from "./lib/qa-scenarios.mjs";

async function defaultStartHost({ runtime, env, extension, scratch, scenario }) {
	const mock = await startMockModel(scenario.model ?? (() => ({ text: "ok" })));
	const agentDir = join(scratch, "agent");
	const workdir = join(scratch, "work");
	mkdirSync(workdir, { recursive: true });
	writeSandboxAgentDir(agentDir, { baseUrl: mock.baseUrl, workdir });
	try {
		const host = await startQaHost({ runtime, env, extension: extension && resolve(extension), scratch, agentDir });
		return { ...host, workdir, stop: async () => Promise.allSettled([host.stop(), mock.stop()]) };
	} catch (error) {
		await mock.stop();
		throw error;
	}
}

function scenarioContext(host, log, controlDir) {
	const subscribe = (subscriber) => host.rpc.subscribe(subscriber);
	return {
		log,
		protocolInfo: host.protocolInfo,
		controlDir,
		control: createControl(controlDir),
		rpc: host.rpc,
		awaitRecord: (predicate, options) => awaitRecord(subscribe, predicate, options),
		async openSession() {
			const opened = await host.rpc.request({
				type: "open_session",
				cwd: host.workdir,
				permissionPreset: "auto",
				provider: MOCK_PROVIDER,
				modelId: MOCK_MODEL,
			});
			if (opened.success !== true) throw new QaFailure("open_session_failed", JSON.stringify(opened.error ?? opened));
			const sessionId = opened.data.sessionId;
			subscribe((record) => {
				if (record.type !== "extension_ui_request" || record.method !== "select") return;
				if (Array.isArray(record.options) && record.options.includes("Allow always")) {
					host.rpc.respondUi(record.id, "Allow always", record.sessionId);
				}
			});
			log.write({ type: "session_opened", sessionId });
			return sessionId;
		},
		async prompt(sessionId, message) {
			const response = await host.rpc.request({ type: "prompt", sessionId, message });
			if (response.success !== true) throw new QaFailure("prompt_failed", JSON.stringify(response.error ?? response));
		},
	};
}

async function runScenario(scenario, host, log, controlDir) {
	const unmet = unmetRequirements(scenario.requires, host.protocolInfo);
	if (unmet.length > 0 || typeof scenario.run !== "function") {
		log.write({ failure: "prerequisite_missing", unmet, implemented: typeof scenario.run === "function" });
		return { kind: "prerequisite" };
	}
	try {
		await scenario.run(scenarioContext(host, log, controlDir));
		return { kind: "passed" };
	} catch (error) {
		const code = error instanceof QaFailure ? error.code : "unexpected_error";
		log.write({ failure: code, message: error instanceof Error ? error.message : String(error) });
		return { kind: "failed", code };
	}
}

function exitFor(outcome, expectFailure, log) {
	if (outcome.kind === "prerequisite") return EXIT.prerequisite;
	if (expectFailure === undefined) return outcome.kind === "passed" ? EXIT.ok : EXIT.failed;
	const observed = outcome.kind === "failed" && outcome.code === expectFailure;
	log.write(observed ? { expected_failure: expectFailure, observed: true } : { expected_failure: expectFailure, observed: false, actual: outcome.code ?? "passed" });
	const recorded = log.readAll().some((record) => record.expected_failure === expectFailure && record.observed === true);
	return observed && recorded ? EXIT.ok : EXIT.failed;
}

export async function runDriver(argv, deps = {}) {
	const parsed = parseQaArgs(argv);
	if (!parsed.ok) {
		process.stderr.write(`tool-child-qa: ${parsed.message}\n`);
		return EXIT.usage;
	}
	const options = parsed.value;
	const scenario = (deps.registry ?? SCENARIOS).find((candidate) => candidate.id === options.scenario);
	if (scenario === undefined) {
		process.stderr.write(`tool-child-qa: unknown scenario ${options.scenario}\n`);
		return EXIT.usage;
	}
	const log = createScenarioLog(join(options.out, `${scenario.id}.jsonl`));
	const scratch = mkdtempSync(process.platform === "win32" ? join(tmpdir(), "tcq-") : "/tmp/tcq-");
	const controlDir = join(scratch, "control");
	mkdirSync(controlDir, { recursive: true });
	const env = { ...injectEnv(options.inject), ...options.env, SENPI_TOOL_CHILD_TEST_CONTROL_DIR: controlDir };
	log.write({ type: "start", scenario: scenario.id, runtime: options.runtime ?? "default", inject: options.inject, env: Object.keys(env) });
	let code = EXIT.failed;
	try {
		const startHost = deps.startHost ?? defaultStartHost;
		let host;
		try {
			host = await startHost({ runtime: options.runtime, env, extension: options.extension, scratch, scenario });
		} catch (error) {
			log.write({ failure: "host_start_failed", message: error instanceof Error ? error.message : String(error) });
			return EXIT.failed;
		}
		try {
			log.write({ type: "host", capabilities: host.protocolInfo.capabilities ?? [] });
			code = exitFor(await runScenario(scenario, host, log, controlDir), options.expectFailure, log);
		} finally {
			await host.stop();
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		writeFileSync(join(options.out, `${scenario.id}.json`), `${JSON.stringify({ scenario: scenario.id, exit: code, records: log.readAll() }, null, 1)}\n`);
	}
	return code;
}

if (import.meta.main) process.exit(await runDriver(process.argv.slice(2)));
