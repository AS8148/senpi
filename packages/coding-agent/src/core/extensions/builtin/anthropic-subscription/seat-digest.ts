import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../config.ts";

const SALT_FILE = join("anthropic-subscription", "seat-digest-salt");
const SALT_BYTES = 32;
const saltsByAgentDir = new Map<string, Buffer>();

function readOrCreateSalt(path: string): Buffer | undefined {
	try {
		return readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
	}
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, randomBytes(SALT_BYTES), { flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
	}
	try {
		return readFileSync(path);
	} catch {
		return undefined;
	}
}

/**
 * The install's salt. A digest is diagnostics and must never fail a turn: an unreadable, unwritable
 * or half-written salt file falls back to a salt for this process only, so digests stay unguessable
 * and merely stop matching across restarts.
 */
function installSalt(agentDir: string): Buffer {
	const cached = saltsByAgentDir.get(agentDir);
	if (cached) return cached;
	const stored = readOrCreateSalt(join(agentDir, SALT_FILE));
	const salt = stored?.length === SALT_BYTES ? stored : randomBytes(SALT_BYTES);
	saltsByAgentDir.set(agentDir, salt);
	return salt;
}

/**
 * An 8-hex digest of an account slot name keyed by a random per-install salt, so logs and
 * diagnostics can tell seats apart without naming them, and a guessed slot name ("env", an email
 * address) cannot be confirmed without this install's salt (oh-my-openagent#10304).
 */
export function seatDigest(accountName: string, agentDir: string = getAgentDir()): string {
	return createHmac("sha256", installSalt(agentDir)).update(accountName).digest("hex").slice(0, 8);
}
