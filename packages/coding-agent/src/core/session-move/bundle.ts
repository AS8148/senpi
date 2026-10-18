import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { parseRepositoryIdentity, type RepositoryIdentity } from "../repository-identity.ts";
import type { MoveId } from "./ownership.ts";

export const MOVE_BUNDLE_FORMAT = 1;
export const MANIFEST_FILE = "manifest.json";
export const SESSION_BUNDLE_PATH = "files/session.jsonl";

export interface BundleFile {
	readonly path: string;
	readonly sha256: string;
}

/**
 * Optional extra payloads travel next to the session without changing its shape. Phase 1 defines none; a later
 * whole-folder transfer adds its own kind here, and an importer that does not know a kind refuses the bundle.
 */
export interface MovePayload {
	readonly kind: string;
	readonly files: readonly BundleFile[];
}

export interface MoveManifest {
	readonly format: typeof MOVE_BUNDLE_FORMAT;
	readonly moveId: MoveId;
	readonly sessionId: string;
	readonly sessionFileName: string;
	readonly sourceCwd: string;
	readonly repository: RepositoryIdentity | undefined;
	readonly session: BundleFile;
	readonly sidecars: readonly BundleFile[];
	readonly droppedUserMessages: readonly string[];
	readonly payloads: readonly MovePayload[];
}

export class MoveBundleInvalidError extends Error {
	readonly code = "move_bundle_invalid";

	constructor(detail: string) {
		super(`The moved session could not be verified (${detail}); it was not imported. The original device keeps it.`);
		this.name = "MoveBundleInvalidError";
	}
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const isString = (value: unknown): value is string => typeof value === "string";

/** Both separators count: a bundle written on one OS is read on another. */
function leavesBundle(path: string): boolean {
	return posix.isAbsolute(path) || win32.isAbsolute(path) || path.split(/[\\/]/).includes("..");
}

function parseFile(value: unknown): BundleFile {
	const file = value as Partial<BundleFile> | null;
	if (typeof file !== "object" || file === null || !isString(file.path) || !isString(file.sha256))
		throw new MoveBundleInvalidError("a listed file is malformed");
	if (leavesBundle(file.path)) throw new MoveBundleInvalidError(`a listed path leaves the bundle: ${file.path}`);
	return { path: file.path, sha256: file.sha256 };
}

/** The importer joins this name onto its session folder, so it must be a plain session file name and nothing else. */
const SESSION_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;

function parseSessionFileName(value: string): string {
	if (!SESSION_FILE_NAME.test(value) || value.includes(".."))
		throw new MoveBundleInvalidError(`the session file name is not a plain file name: ${value}`);
	return value;
}

export function readManifest(bundleDir: string): MoveManifest {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(join(bundleDir, MANIFEST_FILE), "utf8"));
	} catch (error) {
		throw new MoveBundleInvalidError(
			`manifest unreadable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const m = raw as Record<string, unknown>;
	if (m.format !== MOVE_BUNDLE_FORMAT) throw new MoveBundleInvalidError(`unknown bundle format ${String(m.format)}`);
	for (const key of ["moveId", "sessionId", "sessionFileName", "sourceCwd"] as const) {
		if (!isString(m[key])) throw new MoveBundleInvalidError(`missing ${key}`);
	}
	const payloads = Array.isArray(m.payloads) ? m.payloads : [];
	if (payloads.length > 0) throw new MoveBundleInvalidError("it carries a payload this version cannot import");
	const dropped = Array.isArray(m.droppedUserMessages) ? m.droppedUserMessages : [];
	if (!dropped.every(isString)) throw new MoveBundleInvalidError("malformed queued input");
	return {
		format: MOVE_BUNDLE_FORMAT,
		moveId: m.moveId as MoveId,
		sessionId: m.sessionId as string,
		sessionFileName: parseSessionFileName(m.sessionFileName as string),
		sourceCwd: m.sourceCwd as string,
		repository: parseRepositoryIdentity(m.repository),
		session: parseFile(m.session),
		sidecars: (Array.isArray(m.sidecars) ? m.sidecars : []).map(parseFile),
		droppedUserMessages: dropped,
		payloads: [],
	};
}

export function verifyBundle(bundleDir: string, manifest: MoveManifest): void {
	for (const file of [manifest.session, ...manifest.sidecars]) {
		let actual: string;
		try {
			actual = sha256File(join(bundleDir, file.path));
		} catch {
			throw new MoveBundleInvalidError(`missing ${file.path}`);
		}
		if (actual !== file.sha256) throw new MoveBundleInvalidError(`${file.path} changed in transit`);
	}
}
