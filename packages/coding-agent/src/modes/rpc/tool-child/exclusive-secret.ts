import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { SOCKET_SECRET_BYTES } from "../socket-transport.ts";

/** The file a create made: a withdrawal removes only the entry that is still this file. */
export interface FileIdentity {
	readonly dev: number;
	readonly ino: number;
}

export interface ExclusiveSecret {
	readonly secret: Buffer;
	readonly identity: FileIdentity;
}

/** The secret file was created but its write failed; `identity` names the file the caller has to withdraw. */
export class ExclusiveSecretWriteError extends Error {
	readonly identity: FileIdentity;

	constructor(identity: FileIdentity, cause: unknown) {
		super("socket secret write failed", { cause });
		this.identity = identity;
	}
}

/**
 * Writes a fresh 0600 secret as a NEW file at `path`. `O_EXCL` with `O_NOFOLLOW` means nothing that already sits at that
 * name - a file, or a symlink to one - is ever followed, truncated or reused: the open fails with EEXIST (or ELOOP)
 * instead. Nothing is removed here: the caller withdraws a created file only through a root it has proven again.
 */
export async function writeExclusiveSecret(path: string): Promise<ExclusiveSecret> {
	const secret = randomBytes(SOCKET_SECRET_BYTES);
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(path, flags, 0o600);
	try {
		const stat = await handle.stat();
		const identity = { dev: stat.dev, ino: stat.ino };
		try {
			await handle.writeFile(secret);
			await handle.chmod(0o600);
		} catch (error) {
			throw new ExclusiveSecretWriteError(identity, error);
		}
		return { secret, identity };
	} finally {
		await handle.close();
	}
}
