/**
 * `move_session`: the RPC face of the engine's session move (senpi#3676). Each op is one call into
 * `core/session-move/`; this file only parses the request, picks this host's folders (the move ledger, the kept
 * outgoing bundles and the session folder for a working directory) and maps refusals to wire codes.
 */
import { join } from "node:path";
import { getDefaultSessionDir, loadEntriesFromFile } from "../../core/session-manager.ts";
import { parseMoveId } from "../../core/session-move/bundle.ts";
import { exportSessionForMove } from "../../core/session-move/export.ts";
import { finishMove } from "../../core/session-move/finish.ts";
import { answerMoveStatus, importMovedSession } from "../../core/session-move/import.ts";
import { MoveLedger, type MoveRecord, type MoveStatus, parseMoveStatus } from "../../core/session-move/move-ledger.ts";
import { headerSessionId, type MoveId, sessionOwnership } from "../../core/session-move/ownership.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { RpcResponse } from "./rpc-types.ts";
import {
	RPC_ERROR_INVALID_MOVE_REQUEST,
	RPC_ERROR_MOVE_FAILED,
	RPC_ERROR_MOVE_NOT_RELEASED,
	RPC_ERROR_SESSION_OPEN_HERE,
	type RpcMoveRecord,
	type RpcMoveSessionCommand,
	type RpcMoveSessionData,
} from "./session-move-wire.ts";

export interface MoveSessionPort {
	/** This host's agent directory: the move folders live under `<agentDir>/session-moves`. */
	readonly agentDir: string;
	hostedPaths(): readonly string[];
}

/** Refusal codes the move core throws (`error.code`), passed through to the wire as they are. */
const CORE_CODES: ReadonlySet<string> = new Set([
	"move_fenced",
	"move_bundle_invalid",
	"move_repository_mismatch",
	"move_target_occupied",
	"move_mismatch",
	"session_moved_away",
	"session_held",
]);

type Parsed =
	| { readonly op: "prepare" | "cancel"; readonly moveId: MoveId }
	| { readonly op: "status"; readonly moveId: MoveId; readonly sessionPath: string | undefined }
	| {
			readonly op: "export";
			readonly sessionPath: string;
			readonly moveId: MoveId;
			readonly target: string;
			readonly dropped: readonly string[];
	  }
	| { readonly op: "import"; readonly bundleDir: string; readonly cwd: string; readonly from: string }
	| { readonly op: "finish"; readonly sessionPath: string; readonly moveId: MoveId; readonly answer: MoveStatus };

function plainMoveId(value: unknown): MoveId | undefined {
	try {
		return parseMoveId(value);
	} catch {
		return undefined;
	}
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function parse(raw: Record<string, unknown>): Parsed | string {
	const { op } = raw;
	if (op === "import") {
		if (!text(raw.bundleDir) || !text(raw.cwd)) return "import needs bundleDir and cwd.";
		const from = typeof raw.from === "string" ? raw.from : undefined;
		if (raw.from !== undefined && from === undefined) return "from must be a string.";
		return { op, bundleDir: raw.bundleDir, cwd: raw.cwd, from: from ?? "" };
	}
	const id = plainMoveId(raw.moveId);
	if (id === undefined)
		return "moveId must be a plain id: a letter or digit, then letters, digits, '.', '_' or '-', at most 128 characters.";
	switch (op) {
		case "prepare":
		case "cancel":
			return { op, moveId: id };
		case "status": {
			const sessionPath = text(raw.sessionPath) ? raw.sessionPath : undefined;
			if (raw.sessionPath !== undefined && sessionPath === undefined)
				return "sessionPath must be a non-empty string.";
			return { op, moveId: id, sessionPath };
		}
		case "export": {
			const dropped = raw.droppedUserMessages ?? [];
			if (!text(raw.sessionPath) || !text(raw.target)) return "export needs sessionPath and target.";
			if (!Array.isArray(dropped) || !dropped.every((item): item is string => typeof item === "string"))
				return "droppedUserMessages must be the dropped.user_messages strings release_session returned.";
			return { op, sessionPath: raw.sessionPath, moveId: id, target: raw.target, dropped };
		}
		case "finish": {
			const answer = parseMoveStatus(raw.answer);
			if (!text(raw.sessionPath) || answer === undefined)
				return "finish needs sessionPath and the receiver's answer from status (receiving, accepted, declined or failed).";
			return { op, sessionPath: raw.sessionPath, moveId: id, answer };
		}
		default:
			return 'op must be one of "prepare", "cancel", "status", "export", "import" or "finish".';
	}
}

const wireRecord = (record: MoveRecord): RpcMoveRecord =>
	record.state === "ready" ? { state: "ready", expires_at: record.expiresAt } : record;

export async function moveSession(port: MoveSessionPort, command: RpcMoveSessionCommand): Promise<RpcResponse> {
	const raw: Record<string, unknown> = { ...command };
	const parsed = parse(raw);
	if (typeof parsed === "string") return refusal(command.id, RPC_ERROR_INVALID_MOVE_REQUEST, parsed);
	const root = join(port.agentDir, "session-moves");
	const ledger = new MoveLedger(join(root, "ledger"));
	const outgoing = (moveId: MoveId) => join(root, "outgoing", moveId);
	try {
		return answer(command.id, await run(parsed, port, ledger, outgoing));
	} catch (cause) {
		const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
		const detail = cause instanceof Error ? cause.message : String(cause);
		return refusal(
			command.id,
			typeof code === "string" && CORE_CODES.has(code) ? code : RPC_ERROR_MOVE_FAILED,
			detail,
		);
	}
}

async function run(
	parsed: Parsed,
	port: MoveSessionPort,
	ledger: MoveLedger,
	outgoing: (moveId: MoveId) => string,
): Promise<RpcMoveSessionData | { readonly refuse: string; readonly detail: string }> {
	switch (parsed.op) {
		case "prepare":
			return wireRecord(await ledger.prepare(parsed.moveId));
		case "cancel":
			return wireRecord(await ledger.decline(parsed.moveId, "cancelled"));
		case "status":
			return answerMoveStatus(ledger, parsed.moveId, parsed.sessionPath);
		case "export": {
			const sessionFile = normalizePath(parsed.sessionPath);
			if (port.hostedPaths().some((path) => normalizePath(path) === sessionFile))
				return {
					refuse: RPC_ERROR_SESSION_OPEN_HERE,
					detail:
						"This session is open on this host. Release it with release_session reason move and this moveId first.",
				};
			const ownership = sessionOwnership(loadEntriesFromFile(sessionFile));
			if (ownership.writable || ownership.state !== "moving" || ownership.moveId !== parsed.moveId)
				return {
					refuse: RPC_ERROR_MOVE_NOT_RELEASED,
					detail:
						"This session file is not sealed for this move. Release it with release_session reason move and this moveId first; that also hands back its queued input.",
				};
			const bundleDir = outgoing(parsed.moveId);
			const manifest = await exportSessionForMove({
				sessionFile,
				moveId: parsed.moveId,
				target: parsed.target,
				droppedUserMessages: parsed.dropped,
				bundleDir,
			});
			return {
				move_id: manifest.moveId,
				session_id: manifest.sessionId,
				bundle_dir: bundleDir,
				files: 1 + manifest.sidecars.length,
			};
		}
		case "import": {
			const cwd = resolvePath(parsed.cwd);
			const sessionDir = getDefaultSessionDir(cwd, port.agentDir);
			const { sessionFile } = await importMovedSession({
				bundleDir: normalizePath(parsed.bundleDir),
				targetCwd: cwd,
				ledger,
				sessionDir,
				from: parsed.from,
			});
			return { session_id: headerSessionId(loadEntriesFromFile(sessionFile)) ?? "", session_path: sessionFile };
		}
		case "finish": {
			const sessionFile = normalizePath(parsed.sessionPath);
			await finishMove({
				sessionFile,
				bundleDir: outgoing(parsed.moveId),
				moveId: parsed.moveId,
				answer: parsed.answer,
			});
			const ownership = sessionOwnership(loadEntriesFromFile(sessionFile));
			return { ownership: ownership.writable ? "writable" : ownership.state };
		}
	}
}

function answer(id: string | undefined, data: Awaited<ReturnType<typeof run>>): RpcResponse {
	if ("refuse" in data) return refusal(id, data.refuse, data.detail);
	return { id, type: "response", command: "move_session", success: true, data };
}

function refusal(id: string | undefined, code: string, detail: string): RpcResponse {
	return {
		id,
		type: "response",
		command: "move_session",
		success: false,
		error: code,
		errorCode: code,
		errorData: { detail },
	};
}
