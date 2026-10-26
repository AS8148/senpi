import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Ownership of the compact spool's epoch directory (senpi#4272). The store creates the directory
 * itself (0700, never adopting an existing one) and writes a private marker into it; removal
 * re-checks the directory and that marker without following symlinks, so retirement never deletes
 * a directory this store did not create and still own.
 */

const MARKER = ".compact-spool-owner";

type CompactSpoolRefusal =
	| "pre_existing"
	| "symlink"
	| "not_directory"
	| "marker_missing"
	| "foreign_owner"
	| "wide_mode";

class CompactSpoolRefusedError extends Error {
	readonly reason: CompactSpoolRefusal;
	readonly path: string;

	constructor(reason: CompactSpoolRefusal, path: string) {
		super(`compact spool directory refused (${reason}): ${path}`);
		this.name = "CompactSpoolRefusedError";
		this.reason = reason;
		this.path = path;
	}
}

/** Creates a fresh private epoch directory and returns the token its ownership marker holds. */
export async function createSpoolDir(dir: string): Promise<string> {
	await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
	try {
		await mkdir(dir, { mode: 0o700 });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "EEXIST") throw new CompactSpoolRefusedError("pre_existing", dir);
		throw cause;
	}
	const token = randomUUID();
	await writeFile(join(dir, MARKER), token, { flag: "wx", mode: 0o600 });
	return token;
}

/** Removes `dir` only while it is still the private, marked directory `createSpoolDir` made. */
export async function removeSpoolDir(dir: string, token: string): Promise<void> {
	const refusal = await refusalFor(dir, token);
	if (refusal) throw new CompactSpoolRefusedError(refusal, dir);
	await rm(dir, { recursive: true, force: true });
}

async function refusalFor(dir: string, token: string): Promise<CompactSpoolRefusal | undefined> {
	const owned = await lstat(dir);
	if (owned.isSymbolicLink()) return "symlink";
	if (!owned.isDirectory()) return "not_directory";
	const markerPath = join(dir, MARKER);
	const marker = await lstat(markerPath).catch(() => undefined);
	if (!marker?.isFile() || (await readFile(markerPath, "utf8")) !== token) return "marker_missing";
	// Windows has no POSIX owner or mode bits; the marker token and the no-follow checks still apply.
	const uid = process.getuid?.();
	if (uid === undefined) return undefined;
	if (owned.uid !== uid || marker.uid !== uid) return "foreign_owner";
	if (((owned.mode | marker.mode) & 0o077) !== 0) return "wide_mode";
	return undefined;
}
