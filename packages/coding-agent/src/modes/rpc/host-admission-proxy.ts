import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { type HostAdmission, hostStoppingResponse } from "./host-admission.ts";
import { MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "./jsonl.ts";

/**
 * Requests are size-bounded; each direction awaits downstream socket backpressure.
 * Opens remain concurrent with control commands. Stop refuses every pending open,
 * while other commands retain their wire order and child-owned semantics.
 */
export function proxyWithAdmission(client: Socket, internal: Socket | undefined, admission: HostAdmission): void {
	const pending: unknown[] = [];
	const refused = new Set<unknown>();
	const unsubscribe = admission.onStop(async () => {
		const ids = pending.splice(0);
		for (const id of ids) refused.add(id);
		try {
			for (const id of ids)
				await write(client, serializeJsonLine(hostStoppingResponse(id, "open_session", admission)));
		} catch {
			fail();
		}
	});
	client.once("close", () => {
		unsubscribe();
		internal?.destroy();
	});
	const fail = () => {
		internal?.destroy();
		client.destroy();
	};
	client.once("error", fail);
	internal?.once("error", () => {
		if (!admission.stopping) fail();
	});
	void requests().catch(() => {
		if (!admission.stopping) fail();
	});
	if (internal)
		void responses(internal).catch(() => {
			if (!admission.stopping) fail();
		});

	async function requests(): Promise<void> {
		for await (const line of lines(client, MAX_RPC_LINE_CHARACTERS)) {
			if (line === undefined) {
				await write(
					client,
					serializeJsonLine({
						type: "response",
						command: "parse",
						success: false,
						error: `RPC input line exceeds ${MAX_RPC_LINE_CHARACTERS} characters.`,
					}),
				);
				continue;
			}
			const request = record(line);
			if (admission.stopping && request?.type === "get_protocol_info") {
				await write(
					client,
					serializeJsonLine({
						id: request.id,
						type: "response",
						command: request.type,
						success: true,
						data: admission.protocol(),
					}),
				);
			} else if (admission.stopping && (request?.type === "open_session" || !internal)) {
				await write(
					client,
					serializeJsonLine(hostStoppingResponse(request?.id, String(request?.type ?? "parse"), admission)),
				);
			} else if (internal) {
				// Record admission before writing: a child response can arrive immediately.
				if (request?.type === "open_session") pending.push(request.id);
				await write(internal, `${line}\n`);
			}
		}
		internal?.end();
	}

	async function responses(source: Socket): Promise<void> {
		// Responses can contain full histories, unlike the bounded inbound command.
		for await (const line of lines(source, Number.POSITIVE_INFINITY)) {
			if (line === undefined) continue;
			const response = record(line);
			if (response?.type === "response" && response.command === "open_session") {
				if (refused.has(response.id)) continue;
				const index = pending.indexOf(response.id);
				if (index !== -1) pending.splice(index, 1);
			}
			if (response?.type === "response" && response.command === "get_protocol_info" && response.success === true) {
				if (isRecord(response.data)) admission.observe(response.data);
				await write(client, serializeJsonLine({ ...response, data: admission.protocol() }));
			} else await write(client, `${line}\n`);
		}
		if (!admission.stopping) client.end();
	}
}

async function write(socket: Socket, line: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		socket.write(line, (error) => (error ? reject(error) : resolve()));
	});
}

/** Strict LF and incremental UTF-8; an oversized input is discarded through its next LF. */
async function* lines(socket: Socket, limit: number): AsyncGenerator<string | undefined> {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let discarding = false;
	for await (const chunk of socket) {
		const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
		let offset = 0;
		while (offset < text.length) {
			const newline = text.indexOf("\n", offset);
			const end = newline === -1 ? text.length : newline;
			if (!discarding) {
				if (buffer.length + end - offset > limit) {
					buffer = "";
					discarding = true;
					yield undefined;
				} else buffer += text.slice(offset, end);
			}
			if (newline === -1) break;
			if (!discarding) yield buffer;
			buffer = "";
			discarding = false;
			offset = newline + 1;
		}
	}
	buffer += decoder.end();
	if (!discarding && buffer.length > 0) yield buffer;
}

function record(line: string): Readonly<Record<string, unknown>> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
