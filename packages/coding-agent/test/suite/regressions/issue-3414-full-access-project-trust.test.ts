/**
 * senpi#3414 (sisyphuslabs/omo-desktop-app#2465): a session opened with the `full-access` preset
 * must not ask "Trust project folder?": Full access means no prompt anywhere. It trusts its project
 * for that session only (nothing saved), and stops trusting it the moment it leaves Full access.
 * Runs the production router, the in-process registry and the real CLI runtime factory (ONE host
 * per test, like a real daemon), with a project extension that records each load.
 */
import { existsSync, readFileSync, watch } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { CONFIG_DIR_NAME } from "../../../src/config.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";

let scratch: string;
let home: string;
let cwd: string;
let agentDir: string;
let marker: string;
let router: SessionCommandRouter | undefined;
let registry: RpcSessionRegistry | undefined;
const records: Array<Record<string, unknown>> = [];

beforeEach(async () => {
	scratch = await mkdtemp(join(tmpdir(), "senpi-3414-"));
	home = join(scratch, "home", "user");
	cwd = join(home, "project");
	agentDir = join(scratch, "agent");
	marker = join(scratch, "project-extension-loads");
	await mkdir(join(cwd, CONFIG_DIR_NAME, "extensions"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	await writeFile(
		join(cwd, CONFIG_DIR_NAME, "extensions", "marker.ts"),
		`import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(${JSON.stringify(marker)}, "load\\n"); }\n`,
	);
	vi.stubEnv("HOME", home);
	records.length = 0;
	const parsed = parseArgs(["--mode", "rpc", "--multi-session", "--no-context-files"]);
	registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory({ parsed, cwd, agentDir, appMode: "rpc" }),
		closeGraceMs: 1_000,
	});
	// The router answers through the event writer, not as handle()'s return value.
	router = new SessionCommandRouter(
		registry,
		new SessionEventWriter((line) => records.push(JSON.parse(line) as Record<string, unknown>)),
		{ cwd },
	);
});

afterEach(async () => {
	await router?.dispose();
	router = undefined;
	registry = undefined;
	vi.unstubAllEnvs();
	await rm(scratch, { recursive: true, force: true });
});

const loads = (): number => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);

async function open(permissionPreset: string): Promise<string> {
	const before = records.length;
	await router?.handle({ type: "open_session", cwd, permissionPreset });
	const response = records
		.slice(before)
		.find((record) => record.type === "response" && record.command === "open_session");
	if (response?.success !== true)
		throw new Error(`open_session failed: ${JSON.stringify(response ?? records.slice(-3))}`);
	return String((response.data as { sessionId: string }).sessionId);
}

function runtimeOf(sessionId: string) {
	const runtime = registry?.peek(sessionId)?.runtime;
	if (runtime === undefined) throw new Error(`no runtime for ${sessionId}`);
	return runtime;
}

/** A project extension that reports it is loading, then waits for its release file (#3420 races). */
async function writeGate(loading: string, release: string): Promise<void> {
	await writeFile(
		join(cwd, CONFIG_DIR_NAME, "extensions", "gate.ts"),
		`import { existsSync, writeFileSync, watch } from "node:fs";\nimport { dirname } from "node:path";\nexport default async function () {\n\twriteFileSync(${JSON.stringify(loading)}, "x");\n\tif (existsSync(${JSON.stringify(release)})) return;\n\tawait new Promise((resolve) => {\n\t\tconst w = watch(dirname(${JSON.stringify(release)}), () => { if (existsSync(${JSON.stringify(release)})) { w.close(); resolve(undefined); } });\n\t\tif (existsSync(${JSON.stringify(release)})) { w.close(); resolve(undefined); }\n\t});\n}\n`,
	);
}

/** Resolves when `path` appears (the gate extension's "I am loading" marker), or rejects on timeout. */
async function waitForFile(path: string, timeoutMs = 20_000): Promise<void> {
	if (existsSync(path)) return;
	await new Promise<void>((resolve, reject) => {
		const watcher = watch(dirname(path), () => {
			if (!existsSync(path)) return;
			clearTimeout(timer);
			watcher.close();
			resolve();
		});
		const timer = setTimeout(() => {
			watcher.close();
			reject(new Error(`${path} never appeared`));
		}, timeoutMs);
		if (existsSync(path)) {
			clearTimeout(timer);
			watcher.close();
			resolve();
		}
	});
}

describe("Full access trusts the project without asking (#3414)", { timeout: 60_000 }, () => {
	it("a full-access session loads the project's extensions and saves no trust decision", async () => {
		await open("full-access");
		expect(loads()).toBe(1);
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
	});

	it("an ask session in the same host does not inherit a full-access session's trust", async () => {
		await open("full-access");
		expect(loads()).toBe(1);
		await open("ask");
		expect(loads()).toBe(1);
	});

	it("a saved 'do not trust' still wins under full access", async () => {
		new ProjectTrustStore(agentDir).set(cwd, false);
		await open("full-access");
		expect(loads()).toBe(0);
	});

	it("moving a session off Full access stops trusting its project at once", async () => {
		const sessionId = await open("full-access");
		const runtime = runtimeOf(sessionId);
		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(true);

		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		const loader = runtime.session.resourceLoader;
		if (!(loader instanceof DefaultResourceLoader)) throw new Error("expected the default resource loader");
		expect(
			loader
				.getExtensions()
				.extensions.map((extension) => extension.path)
				.filter((path) => path.includes("marker.ts")),
		).toEqual([]);
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
	});

	it("a reload already in flight does not put project code back after the trust is withdrawn", async () => {
		const loading = join(scratch, "gate-loading");
		const release = join(scratch, "gate-release");
		await writeGate(loading, release);
		await writeFile(release, "x");
		const runtime = runtimeOf(await open("full-access"));
		const projectExtensions = (): string[] =>
			runtime.session.extensionRunner
				.getExtensionPaths()
				.filter((path) => path.includes(`${sep}project${sep}${CONFIG_DIR_NAME}${sep}extensions${sep}`));
		expect(projectExtensions()).toHaveLength(2);

		// A user reload that stalls inside the project extension's factory, after it read the trust.
		await rm(release, { force: true });
		await rm(loading, { force: true });
		const userReload = runtime.session.reload();
		await waitForFile(loading);

		runtime.setPermissionPreset("ask");
		const trustChange = runtime.projectTrustChange;
		await writeFile(release, "x");
		await userReload;
		await trustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		// The stalled reload loaded the project's extensions before the trust changed (nothing can undo code
		// that already ran); what must not happen is installing them on the session afterwards.
		expect(projectExtensions()).toEqual([]);
		expect(loads()).toBeGreaterThanOrEqual(1);
	});

	it("going back to Full access trusts the project again and reloads its code", async () => {
		const runtime = runtimeOf(await open("full-access"));
		expect(loads()).toBe(1);

		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;
		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);

		runtime.setPermissionPreset("full-access");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(true);
		expect(loads()).toBe(2);
		expect(new ProjectTrustStore(agentDir).get(cwd)).toBeNull();
	});

	it("a saved 'do not trust' still wins when Full access comes back", async () => {
		const runtime = runtimeOf(await open("full-access"));
		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;
		new ProjectTrustStore(agentDir).set(cwd, false);

		runtime.setPermissionPreset("full-access");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		expect(loads()).toBe(1);
	});

	it("a session replacement built under Full access does not go live trusted after a downgrade", async () => {
		const loading = join(scratch, "replace-loading");
		const release = join(scratch, "replace-release");
		await writeGate(loading, release);
		await writeFile(release, "x");
		const runtime = runtimeOf(await open("full-access"));
		const projectExtensions = (): string[] =>
			runtime.session.extensionRunner
				.getExtensionPaths()
				.filter((path) => path.includes(`${sep}project${sep}${CONFIG_DIR_NAME}${sep}extensions${sep}`));
		expect(projectExtensions()).toHaveLength(2);

		// The replacement is built while the session is still Full access, so it loads the project's code.
		await rm(release, { force: true });
		await rm(loading, { force: true });
		const replacement = runtime.newSession();
		await waitForFile(loading);

		runtime.setPermissionPreset("ask");
		await writeFile(release, "x");
		await replacement;
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		expect(projectExtensions()).toEqual([]);
	});

	it("leaving Full access unloads project code even when a project extension cancels reloads", async () => {
		await writeFile(
			join(cwd, CONFIG_DIR_NAME, "extensions", "veto.ts"),
			'export default function (pi) { pi.on("session_before_reload", () => ({ cancel: true, reason: "kept by the project" })); }\n',
		);
		await mkdir(join(cwd, ".agents", "skills", "project-skill"), { recursive: true });
		await writeFile(
			join(cwd, ".agents", "skills", "project-skill", "SKILL.md"),
			"---\nname: project-skill\ndescription: probe\n---\nbody\n",
		);
		const runtime = runtimeOf(await open("full-access"));
		const projectExtensions = (): string[] =>
			runtime.session.extensionRunner
				.getExtensionPaths()
				.filter((path) => path.includes(`${sep}project${sep}${CONFIG_DIR_NAME}${sep}extensions${sep}`));
		const skillNames = (): string[] => runtime.session.resourceLoader.getSkills().skills.map((skill) => skill.name);
		expect(projectExtensions()).toHaveLength(2);
		expect(skillNames()).toContain("project-skill");
		// The project's veto is live: an ordinary reload would be cancelled.
		expect((await runtime.session.checkReloadVeto()).cancelled).toBe(true);

		runtime.setPermissionPreset("ask");
		await runtime.projectTrustChange;

		expect(runtime.session.settingsManager.isProjectTrusted()).toBe(false);
		expect(projectExtensions()).toEqual([]);
		expect(skillNames()).not.toContain("project-skill");
		expect((await runtime.session.checkReloadVeto()).cancelled).toBe(false);
		expect(runtime.diagnostics.filter((diagnostic) => diagnostic.type === "error")).toEqual([]);
	});
});
