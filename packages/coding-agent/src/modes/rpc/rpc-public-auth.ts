import { randomBytes } from "node:crypto";
import type { Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "./jsonl.ts";
import { authRecord, RPC_AUTH_CAPABILITY, RPC_AUTH_HEX, rpcAuthProof, rpcProofMatches } from "./rpc-auth-proof.ts";
import type { RpcPublicEndpoint } from "./rpc-public-key.ts";
import { SOCKET_HANDSHAKE_TIMEOUT_MS } from "./socket-transport.ts";

const PREAUTH_BYTES = 8 * 1024;

/** Filters public input before it can reach either the proxy or the bare host's router. */
export class PublicRpcConnection {
	readonly input = new PassThrough();
	private readonly raw = new PassThrough();
	private readonly timer: ReturnType<typeof setTimeout>;
	private bytes = 0;
	private active = false;
	private failed = false;
	private first = true;
	private challenge: { readonly id: unknown; readonly client: string; readonly server: string } | undefined;
	private protocolPending = false;
	/**
	 * The admitted connection as one duplex for a router that reads and writes a single stream: it reads only
	 * frames this filter released and writes through `response()`, so the challenge answer gains its proof.
	 */
	get stream(): Duplex {
		this.view ??= this.duplex();
		return this.view;
	}
	private view: Duplex | undefined;

	private readonly socket: Socket;
	private readonly endpoint: RpcPublicEndpoint;
	/** Enforcement: refuse an unauthenticated client. Off by default for one release of logged grace. */
	private readonly requireToken: boolean;

	constructor(
		socket: Socket,
		endpoint: RpcPublicEndpoint,
		requireToken = process.env.SENPI_RPC_REQUIRE_TOKEN === "1",
	) {
		this.socket = socket;
		this.endpoint = endpoint;
		this.requireToken = requireToken;
		socket.pause();
		this.timer = setTimeout(() => socket.destroy(), SOCKET_HANDSHAKE_TIMEOUT_MS);
		const detach = attachJsonlLineReader(this.raw, (line) => this.line(line), {
			maxLineLength: MAX_RPC_LINE_CHARACTERS,
			onOversizedLine: () => socket.destroy(),
		});
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			if (!this.active && !this.failed && !this.requireToken && !this.first) this.grace();
			clearTimeout(this.timer);
			detach();
			this.raw.destroy();
			this.input.end();
		});
		socket.once("end", () => this.raw.end());
		this.input.on("drain", () => socket.resume());
		socket.on("data", (chunk: Buffer) => {
			// Feed a coalesced chunk one LF segment at a time: proof verification can remove
			// the 8 KiB budget before a large authenticated command in that same chunk.
			for (let offset = 0; offset < chunk.length && !this.failed;) {
				const newline = chunk.indexOf(0x0a, offset);
				const end = newline === -1 ? chunk.length : newline + 1;
				const segment = chunk.subarray(offset, end);
				if (!this.active) this.bytes += segment.length;
				if (!this.active && this.bytes > PREAUTH_BYTES) {
					this.failed = true;
					socket.destroy();
					return;
				}
				this.raw.write(segment);
				offset = end;
			}
		});
		void endpoint.ready.then(
			() => {
				if (!socket.destroyed) socket.resume();
			},
			() => socket.destroy(),
		);
	}

	private duplex(): Duplex {
		const input = this.input;
		const stream = new Duplex({
			read: () => input.resume(),
			write: (chunk: Buffer | string, _encoding, callback) => {
				const output = this.response(chunk.toString());
				if (output === "") callback();
				else this.socket.write(output, callback);
			},
			final: (callback) => this.socket.end(callback),
			destroy: (error, callback) => {
				this.socket.destroy();
				callback(error);
			},
		});
		input.on("data", (chunk: Buffer) => {
			if (!stream.push(chunk)) input.pause();
		});
		// Released frames already queued when the peer goes away are still delivered, then the view closes.
		input.once("end", () => {
			stream.push(null);
			stream.destroy();
		});
		if (input.readableEnded) stream.destroy();
		return stream;
	}

	private line(line: string): void {
		if (this.failed || this.socket.destroyed) return;
		let request: Readonly<Record<string, unknown>> | undefined;
		try {
			request = authRecord(JSON.parse(line));
		} catch {
			// Malformed JSON is left to the existing router only after admission.
		}
		if (!this.active) {
			if (this.first && request?.type === "get_protocol_info") {
				this.first = false;
				this.protocolPending = true;
				const nonce = authRecord(request.auth)?.client_nonce;
				if (nonce !== undefined) {
					if (typeof nonce !== "string" || !RPC_AUTH_HEX.test(nonce)) {
						this.refuse(request, "auth_failed");
						return;
					}
					this.challenge = { id: request.id, client: nonce, server: randomBytes(32).toString("hex") };
				} else if (!this.requireToken) this.grace();
				this.forward(line);
				return;
			}
			this.first = false;
			if (request?.type === "authenticate") {
				const c = this.challenge;
				if (
					!c ||
					!rpcProofMatches(
						rpcAuthProof(this.endpoint.key, "client", this.endpoint.launchId, c.server, c.client),
						request.client_proof,
					)
				) {
					this.refuse(request, "auth_failed");
					return;
				}
				this.active = true;
				clearTimeout(this.timer);
				this.socket.write(
					serializeJsonLine({ id: request.id, type: "response", command: "authenticate", success: true }),
				);
				return;
			}
			if (this.requireToken) {
				this.refuse(request, "auth_required");
				return;
			}
			this.grace();
		}
		this.forward(line);
	}

	private forward(line: string): void {
		if (!this.input.write(`${line}\n`)) this.socket.pause();
	}

	private grace(): void {
		this.active = true;
		clearTimeout(this.timer);
		process.stderr.write(
			`senpi rpc host: served a client that did not prove the endpoint key on ${this.endpoint.endpoint} (deprecated, refused from the next release; see docs/rpc.md#authentication)\n`,
		);
	}

	private refuse(request: Readonly<Record<string, unknown>> | undefined, code: "auth_required" | "auth_failed"): void {
		this.failed = true;
		clearTimeout(this.timer);
		this.socket.end(
			serializeJsonLine({
				id: request?.id,
				type: "response",
				command: request?.type ?? "parse",
				success: false,
				error: code,
				errorCode: code,
			}),
			() => this.socket.destroy(),
		);
	}

	/** Writer/proxy batches contain whole JSONL records; ordinary authenticated bytes stay untouched. */
	response(chunk: string): string {
		if (this.failed) return "";
		if (this.active && !this.protocolPending) return chunk;
		let output = "";
		for (const line of chunk.split("\n")) {
			if (!line) continue;
			const record = authRecord(JSON.parse(line));
			if (record?.type === "response" && record.command === "get_protocol_info" && record.success === true) {
				this.protocolPending = false;
				const data = authRecord(record.data) ?? {};
				const capabilities = Array.isArray(data.capabilities) ? data.capabilities : [];
				const c = this.challenge;
				output += serializeJsonLine({
					...record,
					data: {
						...data,
						capabilities: [...new Set([...capabilities, RPC_AUTH_CAPABILITY])],
						...(c && record.id === c.id
							? {
									auth: {
										launch_id: this.endpoint.launchId,
										server_nonce: c.server,
										server_proof: rpcAuthProof(
											this.endpoint.key,
											"server",
											this.endpoint.launchId,
											c.client,
											c.server,
										),
									},
								}
							: {}),
					},
				});
			} else if (this.active) output += `${line}\n`;
		}
		return output;
	}
}
