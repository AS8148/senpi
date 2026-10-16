import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../../../src/modes/rpc/jsonl.ts";
import { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import { REQUEST_DEADLINE_MS } from "../../../src/modes/rpc/rpc-request-deadline.ts";

async function abortHost() {
	const directory = await mkdtemp(join(tmpdir(), "rpc-abort-deadline-"));
	const socketPath = join(directory, "rpc.sock");
	const connected = Promise.withResolvers<Socket>();
	const abort = Promise.withResolvers<{ id: string }>();
	const server = createServer((socket) => {
		connected.resolve(socket);
		attachJsonlLineReader(socket, (line) => {
			const command = JSON.parse(line) as { id: string; type: string };
			if (command.type === "abort") abort.resolve({ id: command.id });
		});
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	const client = new RpcClient({ socketPath });
	await client.start();
	const peer = await connected.promise;
	return {
		client,
		abort: abort.promise,
		answer(id: string) {
			peer.write(
				serializeJsonLine({
					type: "response",
					command: "abort",
					id,
					success: true,
					data: { stopped: true, idle: true },
				}),
			);
		},
		async close() {
			await client.stop();
			peer.destroy();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

describe("RpcClient waits for an awaited abort as long as the host may take (senpi#3453)", () => {
	afterEach(() => vi.useRealTimers());

	test.each([
		{ graceMs: 45_000, waited: 45_000 },
		{ graceMs: undefined, waited: 10_000 },
	])("abort({ awaitIdle, graceMs: $graceMs }) still gets the host's answer after $waited ms", async ({ graceMs, waited }) => {
		// Given: a socket host that answers the awaited abort only when its grace runs out
		const host = await abortHost();
		try {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const answer = host.client
				.abort({ effectId: "stop-1", awaitIdle: true, ...(graceMs === undefined ? {} : { graceMs }) })
				.catch((error: unknown) => error);
			const { id } = await host.abort;

			// When: the grace (past the plain 30 s request deadline for 45 s) elapses before the host answers
			await vi.advanceTimersByTimeAsync(Math.max(waited, REQUEST_DEADLINE_MS) + 1_000);
			host.answer(id);

			// Then: the client was still waiting and returns the typed answer
			expect(await answer).toEqual({ stopped: true, idle: true });
		} finally {
			await host.close();
		}
	});
});
