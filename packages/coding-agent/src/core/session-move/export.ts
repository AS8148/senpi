import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { readRecordedRepositoryIdentity, readSessionCwd } from "../session-rebind.ts";
import { loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { encodedSessionId } from "../session-sidecar-store.ts";
import {
	type BundleFile,
	MANIFEST_FILE,
	MOVE_BUNDLE_FORMAT,
	type MoveManifest,
	SESSION_BUNDLE_PATH,
	sha256File,
} from "./bundle.ts";
import { type MoveId, SESSION_RELEASED, SessionMovedAwayError, sessionOwnership } from "./ownership.ts";

export interface ExportSessionForMoveOptions {
	/** A session no live runtime holds: an RPC host releases it first (`release_session` reason `move`). */
	readonly sessionFile: string;
	readonly moveId: MoveId;
	readonly target: string;
	/** Queued user input the release took out of the session (`dropped.user_messages`), in order. */
	readonly droppedUserMessages: readonly string[];
	readonly bundleDir: string;
}

/**
 * Seals the session for the move (a `session_released` entry with reason `move`; from then on this device refuses
 * writes) and writes a self-verifying bundle: the session file, its extension sidecars and resident blobs, and a
 * manifest. Running it again for the same move rewrites the same bundle without a second release entry.
 */
export async function exportSessionForMove(options: ExportSessionForMoveOptions): Promise<MoveManifest> {
	const { sessionFile, moveId } = options;
	const ownership = sessionOwnership(loadEntriesFromFile(sessionFile));
	if (!ownership.writable && !(ownership.state === "moving" && ownership.moveId === moveId)) {
		throw new SessionMovedAwayError(sessionFile, ownership);
	}
	if (ownership.writable) {
		SessionManager.open(sessionFile).appendCustomEntry(SESSION_RELEASED, {
			reason: "move",
			move_id: moveId,
			target: options.target,
			released_at: new Date().toISOString(),
		});
	}
	const header = loadEntriesFromFile(sessionFile)[0] as { readonly id?: unknown } | undefined;
	const sessionId = typeof header?.id === "string" ? header.id : "";
	const staging = `${options.bundleDir}.partial-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(join(staging, dirname(SESSION_BUNDLE_PATH)), { recursive: true });
	copyFileSync(sessionFile, join(staging, SESSION_BUNDLE_PATH));
	const sidecars = copySidecars(dirname(sessionFile), sessionId, staging);
	const manifest: MoveManifest = {
		format: MOVE_BUNDLE_FORMAT,
		moveId,
		sessionId,
		sessionFileName: basename(sessionFile),
		sourceCwd: readSessionCwd(sessionFile) ?? "",
		repository: readRecordedRepositoryIdentity(sessionFile),
		session: { path: SESSION_BUNDLE_PATH, sha256: sha256File(join(staging, SESSION_BUNDLE_PATH)) },
		sidecars,
		droppedUserMessages: [...options.droppedUserMessages],
		payloads: [],
	};
	writeFileSync(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 1)}\n`);
	rmSync(options.bundleDir, { recursive: true, force: true });
	renameSync(staging, options.bundleDir);
	return manifest;
}

function copySidecars(sessionDir: string, sessionId: string, staging: string): BundleFile[] {
	const sources: string[] = [];
	const extensions = join(sessionDir, "extensions");
	const sidecarName = `${encodedSessionId(sessionId)}.json`;
	if (existsSync(extensions)) {
		for (const extension of readdirSync(extensions, { withFileTypes: true })) {
			const file = join(extensions, extension.name, sidecarName);
			if (extension.isDirectory() && existsSync(file)) sources.push(file);
		}
	}
	sources.push(...filesUnder(join(sessionDir, "resident-blobs", sessionId)));
	return sources.map((source) => {
		const path = join("files", relative(sessionDir, source));
		mkdirSync(dirname(join(staging, path)), { recursive: true });
		copyFileSync(source, join(staging, path));
		return { path, sha256: sha256File(source) };
	});
}

function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
	);
}
