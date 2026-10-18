/**
 * The private channel between the server and one tool child generation (senpi#3566, plan todo 4).
 *
 * The server listens on a per-generation socket inside a 0700 directory, guarded by a 0600 secret the child must send
 * first (`socket-transport.ts`), and accepts exactly one connection; the listener closes after it. The child learns the
 * address and the secret file from its environment, never from argv. Frames are `codec.ts` length-prefixed frames, never
 * stdout, so nothing a tool prints can corrupt the protocol. Any codec error is terminal for the channel.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rm, rmdir } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "../socket-ownership.ts";
import {
	authenticateSocket,
	createSocketSecret,
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../socket-transport.ts";
import { encodeFrame, FrameDecoder, ToolChildCodecError } from "./codec.ts";
import type { ToolChildMessage } from "./protocol.ts";

export const TOOL_CHILD_ROLE_ENV = "SENPI_INTERNAL_ROLE";
export const TOOL_CHILD_CHANNEL_ENV = "SENPI_TOOL_CHILD_CHANNEL";
export const TOOL_CHILD_SECRET_ENV = "SENPI_TOOL_CHILD_CHANNEL_SECRET";

export type ChannelCloseReason =
	| { readonly kind: "eof" }
	| { readonly kind: "codec"; readonly code: ToolChildCodecError["code"] }
	| { readonly kind: "error"; readonly message: string };

export interface ToolChildChannel {
	send(message: ToolChildMessage): boolean;
	/** Subscribes; the returned function unsubscribes. */
	onMessage(listener: (message: ToolChildMessage) => void): () => void;
	readonly closed: Promise<ChannelCloseReason>;
	close(): void;
}

export function wrapChannelSocket(socket: Socket): ToolChildChannel {
	const decoder = new FrameDecoder();
	const listeners: Array<(message: ToolChildMessage) => void> = [];
	// Frames that arrive before anyone listens (a child's `hello` races the server's subscription) wait here.
	const early: ToolChildMessage[] = [];
	let settle!: (reason: ChannelCloseReason) => void;
	const closed = new Promise<ChannelCloseReason>((resolve) => {
		settle = resolve;
	});
	let reason: ChannelCloseReason | undefined;
	const finish = (next: ChannelCloseReason): void => {
		if (reason !== undefined) return;
		reason = next;
		socket.destroy();
		settle(next);
	};
	socket.on("data", (chunk: Buffer) => {
		if (reason !== undefined) return;
		try {
			for (const message of decoder.push(chunk)) {
				if (listeners.length === 0) early.push(message);
				else for (const listener of listeners) listener(message);
			}
		} catch (error) {
			finish(
				error instanceof ToolChildCodecError
					? { kind: "codec", code: error.code }
					: { kind: "error", message: String(error) },
			);
		}
	});
	socket.on("end", () => {
		try {
			decoder.end();
			finish({ kind: "eof" });
		} catch (error) {
			finish(
				error instanceof ToolChildCodecError
					? { kind: "codec", code: error.code }
					: { kind: "error", message: String(error) },
			);
		}
	});
	socket.on("error", (error) => finish({ kind: "error", message: error.message }));
	socket.on("close", () => finish({ kind: "eof" }));
	return {
		send: (message) => reason === undefined && socket.write(encodeFrame(message)),
		onMessage: (listener) => {
			listeners.push(listener);
			for (const message of early.splice(0)) listener(message);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		closed,
		close: () => finish({ kind: "eof" }),
	};
}

export interface ChannelListener {
	readonly env: Readonly<Record<typeof TOOL_CHILD_CHANNEL_ENV | typeof TOOL_CHILD_SECRET_ENV, string>>;
	/** The first authenticated connection; the listener stops accepting once it arrives. */
	readonly accepted: Promise<ToolChildChannel>;
	close(): Promise<void>;
}

/**
 * `<dir>/c-<generation>.sock` when it fits `sun_path`; otherwise the same name under a short private directory,
 * `/tmp/senpi-tc-<sha256(dir)[:12]>/` - never `TMPDIR`, whose macOS default is itself too long. The fallback is
 * predictable, so it is used only when it is a real directory of this user with no group or other access.
 */
export async function channelSocketPath(dir: string, generation: number): Promise<string> {
	const name = `c-${generation}.sock`;
	const primary = join(dir, name);
	if (process.platform === "win32" || Buffer.byteLength(primary) <= MAX_SOCKET_PATH_BYTES) {
		await makePrivateDirectory(dir);
		return primary;
	}
	const root = fallbackSocketRoot(dir);
	await claimPrivateDirectory(root);
	return join(root, name);
}

/** The short private directory a socket falls back to when `<dir>/c-<generation>.sock` does not fit `sun_path`. */
export function fallbackSocketRoot(dir: string): string {
	return join("/tmp", `senpi-tc-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`);
}

/**
 * A predictable directory under the shared `/tmp` is used only if it is a real directory of this user. It is opened
 * without following a symlink and checked through that handle before its mode is tightened, so nothing planted at the
 * path - a symlink or another user's directory - is ever changed or used.
 */
async function claimPrivateDirectory(root: string): Promise<void> {
	await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
		if (Reflect.get(Object(error), "code") !== "EEXIST") throw error;
	});
	const unsafe = () => new Error(`socket_dir_unsafe: ${root} is not a private directory of this user`);
	const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => {
		throw unsafe();
	});
	try {
		const stat = await handle.stat();
		if (!stat.isDirectory() || (process.getuid !== undefined && stat.uid !== process.getuid())) throw unsafe();
		if ((stat.mode & 0o077) !== 0) await handle.chmod(0o700);
	} finally {
		await handle.close();
	}
}

async function makePrivateDirectory(directory: string): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await chmod(directory, 0o700);
}

export async function openChannelListener(options: {
	readonly dir: string;
	readonly generation: number;
}): Promise<ChannelListener> {
	const logicalPath = await channelSocketPath(options.dir, options.generation);
	const secretPath = socketSecretPath(logicalPath);
	await rm(logicalPath, { force: true });
	const secret = await createSocketSecret(secretPath);
	let resolveAccepted!: (channel: ToolChildChannel) => void;
	const accepted = new Promise<ToolChildChannel>((resolve) => {
		resolveAccepted = resolve;
	});
	let taken = false;
	const server = createServer((socket) => {
		if (taken) {
			socket.destroy();
			return;
		}
		authenticateSocket(socket, secret, () => {
			if (taken) {
				socket.destroy();
				return;
			}
			taken = true;
			server.close();
			resolveAccepted(wrapChannelSocket(socket));
		});
	});
	const address = resolveSocketTransportAddress(logicalPath, process.platform, secret);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(address, () => {
			server.off("error", reject);
			resolve();
		});
	});
	if (process.platform !== "win32") await chmod(logicalPath, 0o600);
	return {
		env: { [TOOL_CHILD_CHANNEL_ENV]: logicalPath, [TOOL_CHILD_SECRET_ENV]: secretPath },
		accepted,
		close: async () => {
			taken = true;
			// Stops accepting only: `server.close(callback)` would wait for the accepted channel itself to end.
			if (server.listening) server.close();
			await rm(secretPath, { force: true });
			if (process.platform !== "win32") await rm(logicalPath, { force: true });
			// The private socket root is per agent dir and generations share it, so rmdir succeeds only when this
			// was the last one - a best-effort sweep that never races a live sibling (senpi#3576, CI temp guard).
			await rmdir(dirname(logicalPath)).catch(() => {});
		},
	};
}

export function channelEnvPresent(env: NodeJS.ProcessEnv): boolean {
	return Boolean(env[TOOL_CHILD_CHANNEL_ENV]) && Boolean(env[TOOL_CHILD_SECRET_ENV]);
}

export async function connectChannel(env: NodeJS.ProcessEnv): Promise<ToolChildChannel> {
	const logicalPath = env[TOOL_CHILD_CHANNEL_ENV];
	const secretPath = env[TOOL_CHILD_SECRET_ENV];
	if (!logicalPath || !secretPath) throw new Error("tool-child: channel unavailable");
	const secret = await readSocketSecret(secretPath);
	const socket = createConnection(resolveSocketTransportAddress(logicalPath, process.platform, secret));
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	sendSocketHandshake(socket, secret);
	return wrapChannelSocket(socket);
}
