import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { SOCKET_SECRET_BYTES } from "../socket-transport.ts";

/**
 * Writes a fresh 0600 secret as a NEW file at `path`. `O_EXCL` with `O_NOFOLLOW` means nothing that already sits at that
 * name - a file, or a symlink to one - is ever followed, truncated or reused: the open fails with EEXIST (or ELOOP)
 * instead. A partial write removes the file it created.
 */
export async function writeExclusiveSecret(path: string): Promise<Buffer> {
	const secret = randomBytes(SOCKET_SECRET_BYTES);
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
	const handle = await open(path, flags, 0o600);
	try {
		await handle.writeFile(secret);
		await handle.chmod(0o600);
	} catch (error) {
		await handle.close();
		await rm(path, { force: true });
		throw error;
	}
	await handle.close();
	return secret;
}
