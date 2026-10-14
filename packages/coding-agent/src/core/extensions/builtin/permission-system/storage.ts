import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "../../../../config.ts";
import type { Rule, Ruleset } from "./types.ts";

const PERMISSIONS_FILE = "permissions-approved.jsonl";
const MIGRATED_MARKER = ".migrated";

/** Marker only the user-answer path (persistAlways / migration) writes; forgery without it is dropped. */
const USER_ANSWER_SOURCE = "user-answer";

/** The permission kinds an approved rule may name; a wildcard or unknown kind is never approved. */
const KNOWN_PERMISSIONS = new Set(["read", "list", "grep", "edit", "bash", "external_directory", "webfetch"]);

function getLegacyPermissionsPath(projectDir: string): string {
	return path.join(projectDir, CONFIG_DIR_NAME, PERMISSIONS_FILE);
}

/** Realpath of the project (symlinks resolved); falls back to the normalized spelling when absent. */
function canonicalProjectDir(projectDir: string): string {
	try {
		return fs.realpathSync.native(projectDir);
	} catch {
		return path.resolve(projectDir);
	}
}

/** The per-user store for one project: out of the workspace, keyed by the project's real path. */
export function approvedStorePath(agentDir: string, projectDir: string): string {
	const hash = createHash("sha256").update(canonicalProjectDir(projectDir)).digest("hex").slice(0, 16);
	return path.join(agentDir, "permissions", "approved", `${hash}.jsonl`);
}

/** The store path the permission system must never let the agent write (defence in depth). */
export function approvedStoreRealPath(agentDir: string, projectDir: string): string {
	const store = approvedStorePath(agentDir, projectDir);
	try {
		return fs.realpathSync.native(store);
	} catch {
		return store;
	}
}

/** A well-formed pattern is a non-empty string without embedded newlines. */
function isWellFormedPattern(pattern: unknown): pattern is string {
	return typeof pattern === "string" && pattern.length > 0 && !pattern.includes("\n") && !pattern.includes("\r");
}

/**
 * Validates one loaded line: action 'allow', a known (non-wildcard) permission kind, a well-formed
 * pattern, and the user-answer source marker only the answer path writes. Anything else is dropped.
 */
function toApprovedRule(value: unknown): Rule | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const candidate = value as Record<string, unknown>;
	if (candidate.action !== "allow") return undefined;
	if (typeof candidate.permission !== "string" || !KNOWN_PERMISSIONS.has(candidate.permission)) return undefined;
	if (!isWellFormedPattern(candidate.pattern)) return undefined;
	if (candidate.source !== USER_ANSWER_SOURCE) return undefined;
	return { permission: candidate.permission, pattern: candidate.pattern, action: "allow" };
}

function readRules(filePath: string): Ruleset {
	if (!fs.existsSync(filePath)) return [];
	const content = fs.readFileSync(filePath, "utf-8");
	const lines = content.split("\n").filter((line) => line.trim() !== "");
	const rules: Rule[] = [];
	for (const line of lines) {
		try {
			const rule = toApprovedRule(JSON.parse(line));
			if (rule) rules.push(rule);
		} catch {}
	}
	return rules;
}

/**
 * Loads the project's approved rules from the agent-dir store. On first load for a project, a
 * legacy `<cwd>/.senpi/permissions-approved.jsonl` is imported ONCE (validated, user-marked lines
 * only) and then REMOVED, so a line planted there later is never honored. A failed import leaves
 * the legacy file in place. Later loads read only the store.
 */
export function loadApproved(agentDir: string, projectDir: string): Ruleset {
	const storePath = approvedStorePath(agentDir, projectDir);
	const legacyPath = getLegacyPermissionsPath(projectDir);
	const migratedMarker = `${storePath}${MIGRATED_MARKER}`;
	const alreadyMigrated = fs.existsSync(migratedMarker) || fs.existsSync(storePath);

	if (!alreadyMigrated && fs.existsSync(legacyPath)) {
		const imported = readRules(legacyPath);
		try {
			const dir = path.dirname(storePath);
			if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
			const lines = imported.map((rule) => JSON.stringify({ ...rule, source: USER_ANSWER_SOURCE })).join("\n");
			fs.writeFileSync(storePath, lines ? `${lines}\n` : "", { flag: "w" });
			fs.writeFileSync(migratedMarker, "");
			fs.rmSync(legacyPath, { force: true });
		} catch {
			// A failed import leaves the legacy file and logs nothing here; the next load retries it.
		}
		return imported;
	}

	return readRules(storePath);
}

/** Cheap identity of the store: mtime + size, so a service re-reads only on change. */
export function approvedFileVersion(agentDir: string, projectDir: string): string | undefined {
	const filePath = approvedStorePath(agentDir, projectDir);
	try {
		const stat = fs.statSync(filePath);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return undefined;
	}
}

/** Appends user-answer rules to the store, each stamped with the source marker. */
export function appendApproved(agentDir: string, projectDir: string, rules: Rule[]): void {
	if (rules.length === 0) return;
	const filePath = approvedStorePath(agentDir, projectDir);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const lines = `${rules.map((rule) => JSON.stringify({ ...rule, source: USER_ANSWER_SOURCE })).join("\n")}\n`;
	fs.appendFileSync(filePath, lines, { flag: "a" });
}

export function clearApproved(agentDir: string, projectDir: string): void {
	const filePath = approvedStorePath(agentDir, projectDir);
	if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

export function compactApproved(agentDir: string, projectDir: string): void {
	const filePath = approvedStorePath(agentDir, projectDir);
	if (!fs.existsSync(filePath)) return;
	const rules = loadApproved(agentDir, projectDir);
	const seen = new Map<string, Rule>();
	for (const rule of rules) seen.set(`${rule.permission}:${rule.pattern}`, rule);
	const uniqueRules = Array.from(seen.values());
	const lines = uniqueRules.map((rule) => JSON.stringify({ ...rule, source: USER_ANSWER_SOURCE })).join("\n");
	fs.writeFileSync(filePath, lines ? `${lines}\n` : "", { flag: "w" });
}
