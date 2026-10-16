import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import chalk from "chalk";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { findGitPaths } from "./footer-data-provider.ts";

export interface ContextFile {
	path: string;
	content: string;
}

/** Size limits for AGENTS.md / CLAUDE.md context files, which ride along on every model request. */
export interface ContextFileLimits {
	maxBytesPerFile?: number;
	maxTotalBytes?: number;
}

export const DEFAULT_CONTEXT_FILE_MAX_BYTES = 64 * 1024;
export const DEFAULT_CONTEXT_FILES_MAX_TOTAL_BYTES = 128 * 1024;
const MIN_USEFUL_BYTES = 1024;

function loadContextFileFromDir(dir: string): ContextFile | null {
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) {
					continue;
				}
				return {
					path: filePath,
					content: stripBom(readFileSync(filePath, "utf-8")),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * occupy the same logical repository scope, so loading both applies that context twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned canonicalized (realpath), because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`).
 */
function findShadowedContextFile(cwd: string): string | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	// False for an ordinary repo, where the two are the same dir, and for a sibling
	// worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
	if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
	// dirname of the common git dir is the main worktree root only when that dir is
	// itself checked out from the same repo. In a bare layout (`proj/.bare` +
	// `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
	// submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
	if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

function kib(bytes: number): string {
	const value = bytes / 1024;
	return Number.isInteger(value) ? `${value} KiB` : `${value.toFixed(1)} KiB`;
}

function utf8Prefix(content: string, maxBytes: number): string {
	const bytes = Buffer.from(content, "utf8");
	let end = Math.min(maxBytes, bytes.length);
	while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf8");
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Bound what the context files add to every request. Files are given budget nearest-first
 * (the cwd's file before its ancestors, the global file last), so the most specific
 * instructions survive; every cut or skipped file is named in a warning.
 */
function applyContextFileLimits(files: ContextFile[], limits: ContextFileLimits): ContextFile[] {
	const perFile = positiveLimit(limits.maxBytesPerFile, DEFAULT_CONTEXT_FILE_MAX_BYTES);
	const total = positiveLimit(limits.maxTotalBytes, DEFAULT_CONTEXT_FILES_MAX_TOTAL_BYTES);
	const limitText = `limit ${kib(perFile)} per file, ${kib(total)} total; raise contextFiles.maxBytesPerFile / contextFiles.maxTotalBytes in settings to load more`;
	const kept: ContextFile[] = [];
	let remaining = total;
	for (const file of [...files].reverse()) {
		const size = Buffer.byteLength(file.content, "utf8");
		const allowed = Math.min(perFile, remaining);
		if (size <= allowed) {
			kept.unshift(file);
			remaining -= size;
			continue;
		}
		if (allowed < MIN_USEFUL_BYTES) {
			console.error(
				chalk.yellow(
					`Warning: context file ${file.path} (${kib(size)}) was not loaded: nearer context files used the budget (${limitText}).`,
				),
			);
			continue;
		}
		const prefix = utf8Prefix(file.content, allowed);
		const loaded = Buffer.byteLength(prefix, "utf8");
		console.error(
			chalk.yellow(
				`Warning: context file ${file.path} is ${kib(size)}; only the first ${kib(loaded)} was loaded (${limitText}).`,
			),
		);
		kept.unshift({
			path: file.path,
			content: `${prefix}\n\n[This file was truncated: ${kib(loaded)} of ${kib(size)} loaded.]`,
		});
		remaining -= loaded;
	}
	return kept;
}

export function loadProjectContextFiles(options: { cwd: string; agentDir: string } & ContextFileLimits): ContextFile[] {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: ContextFile[] = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: ContextFile[] = [];

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	let currentDir = resolvedCwd;

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		const isShadowed =
			shadowedContextFile !== undefined && canonicalizePath(contextFile?.path ?? "") === shadowedContextFile;
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return applyContextFileLimits(contextFiles, options);
}
