import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import {
	compareRepositoryIdentities,
	type RepositoryIdentity,
	readRepositoryIdentity,
} from "../repository-identity.ts";
import { getDefaultSessionDir, loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { rebindSessionFile } from "../session-rebind.ts";
import { MoveBundleInvalidError, type MoveManifest, readManifest, verifyBundle } from "./bundle.ts";
import type { MoveLedger } from "./move-ledger.ts";
import { type MoveId, SESSION_MOVED_IN } from "./ownership.ts";
import { requeueInput } from "./requeue.ts";

export interface ImportMovedSessionOptions {
	readonly bundleDir: string;
	readonly targetCwd: string;
	readonly ledger: MoveLedger;
	readonly sessionDir?: string;
	readonly from?: string;
	readonly readIdentity?: (dir: string) => Promise<RepositoryIdentity | undefined>;
}

export class MoveRefusedError extends Error {
	readonly code: "move_repository_mismatch";

	constructor(targetCwd: string, sourceCwd: string) {
		super(
			`${targetCwd} is not the same repository the session was recorded in (${sourceCwd}). Pick a checkout of the same repository, or copy the session into this folder instead.`,
		);
		this.name = "MoveRefusedError";
		this.code = "move_repository_mismatch";
	}
}

const movedInFor = (file: string, moveId: MoveId): boolean =>
	loadEntriesFromFile(file).some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === SESSION_MOVED_IN &&
			(entry.data as { move_id?: unknown } | undefined)?.move_id === moveId,
	);

/**
 * Brings a moved session in. The bundle is verified, the folder must be the same repository (the `--rebind` rule),
 * and everything is assembled in a staging folder: the session file gains its queued input back and then
 * `session_moved_in`, so the rename into the session directory, run under the move's ledger lock, is the single
 * commit point. Importing a bundle already imported returns the session without changing it.
 */
export async function importMovedSession(
	options: ImportMovedSessionOptions,
): Promise<{ readonly sessionFile: string }> {
	const manifest = readManifest(options.bundleDir);
	const targetCwd = resolvePath(options.targetCwd);
	const sessionDir = options.sessionDir ? normalizePath(options.sessionDir) : getDefaultSessionDir(targetCwd);
	const target = join(sessionDir, manifest.sessionFileName);
	if (existsSync(target) && movedInFor(target, manifest.moveId)) {
		// The rename already committed; a crash may have lost the ledger write, and the file is the authority.
		await options.ledger.commit(manifest.moveId, () => undefined);
		return { sessionFile: target };
	}
	try {
		verifyBundle(options.bundleDir, manifest);
	} catch (error) {
		if (error instanceof MoveBundleInvalidError) await options.ledger.fail(manifest.moveId, "bundle_invalid");
		throw error;
	}
	const read = options.readIdentity ?? readRepositoryIdentity;
	if (compareRepositoryIdentities(manifest.repository, await read(targetCwd)) !== "same") {
		await options.ledger.decline(manifest.moveId, "repository");
		throw new MoveRefusedError(targetCwd, manifest.sourceCwd);
	}
	await options.ledger.beginReceive(manifest.moveId);
	const staged = await stage(options.bundleDir, manifest, sessionDir, options.from ?? "");
	const sessionFile = await options.ledger.commit(manifest.moveId, () =>
		rebindSessionFile(staged, targetCwd, sessionDir),
	);
	rmSync(dirname(staged), { recursive: true, force: true });
	return { sessionFile };
}

async function stage(bundleDir: string, manifest: MoveManifest, sessionDir: string, from: string): Promise<string> {
	const staging = join(sessionDir, ".move-staging", encodeURIComponent(manifest.moveId));
	const file = join(staging, manifest.sessionFileName);
	if (!(existsSync(file) && movedInFor(file, manifest.moveId))) {
		rmSync(staging, { recursive: true, force: true });
		for (const item of [manifest.session, ...manifest.sidecars]) {
			const to = item === manifest.session ? file : join(staging, item.path.replace(/^files\//, ""));
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(join(bundleDir, item.path), to);
		}
		SessionManager.open(file, staging).appendCustomEntry(SESSION_MOVED_IN, {
			move_id: manifest.moveId,
			from,
			bundle_sha256: manifest.session.sha256,
			moved_in_at: new Date().toISOString(),
		});
	}
	// Ids are stable per move, so a staging pass that crashed after some of these replays them instead of doubling.
	await requeueInput(file, manifest.moveId, manifest.droppedUserMessages);
	return file;
}
