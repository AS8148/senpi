/**
 * senpi#3414 (sisyphuslabs/omo-desktop-app#2465): a session opened with the `full-access` preset
 * must not ask "Trust project folder?": Full access means no prompt anywhere. It trusts its project
 * for that session only (nothing saved). Runs the production router, the in-process registry and
 * the real CLI runtime factory, with a project extension that leaves a marker when it loads.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { CONFIG_DIR_NAME } from "../../../src/config.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

let scratch: string;
let cwd: string;
let agentDir: string;
let marker: string;
let router: SessionCommandRouter | undefined;

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-3414-"));
	cwd = join(scratch, "home", "user", "project");
	agentDir = join(scratch, "agent");
	marker = join(scratch, "project-extension-ran");
	await mkdir(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(cwd, CONFIG_DIR_NAME, "extensions", "marker.ts"),
		`import { writeFileSync } from "node:fs";\nexport default function () { writeFileSync(${JSON.stringify(marker)}, "ran"); }\n`,
	);
	vi.stubEnv("HOME", join(scratch, "home", "user"));
});

afterEach(async () => {
	await router?.dispose();
	router = undefined;
	vi.unstubAllEnvs();
	await rm(scratch, { recursive: true, force: true });
});

async function open(permissionPreset: string) {
	const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--no-skills", "--no-context-files"]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory({ parsed, cwd, agentDir, appMode: "rpc" }),
		closeGraceMs: 1_000,
	});
	// The router answers through the event writer, not as handle()'s return value.
	const records: Array<Record<string, unknown>> = [];
	router = new SessionCommandRouter(
		registry,
		new SessionEventWriter((line) => records.push(JSON.parse(line) as Record<string, unknown>)),
		{ cwd },
	);
	await router.handle({ type: "open_session", cwd, permissionPreset });
	const response = records.find((record) => record.type === "response" && record.command === "open_session");
	if (response?.success !== true)
		throw new Error(`open_session failed: ${JSON.stringify(response ?? records.slice(-3))}`);
}

describe("Full access trusts the project without asking (#3414)", { timeout: 60_000 }, () => {
	it("a full-access session loads the project's extensions and saves no trust decision", async () => {
		await open("full-access");
		expect(existsSync(marker)).toBe(true);
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
	});

	it("an ask session in the same folder does not get that trust", async () => {
		await open("ask");
		expect(existsSync(marker)).toBe(false);
	});

	it("a saved 'do not trust' still wins under full access", async () => {
		new ProjectTrustStore(agentDir).set(cwd, false);
		await open("full-access");
		expect(existsSync(marker)).toBe(false);
	});
});
