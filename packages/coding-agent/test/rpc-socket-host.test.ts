import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.ts";

import { startFakeModelServer } from "./helpers/rpc-fake-model.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "./helpers/rpc-hermetic.ts";
import {
	connectPeer,
	messageText,
	openedSessionId,
	scratch,
	spawnRpc,
	waitForStderr,
} from "./helpers/rpc-socket-host-support.ts";

describe("RPC Unix-socket multi-connection host", () => {
	it("parses socket listeners as multi-session RPC", () => {
		expect(parseArgs(["--mode", "rpc", "--listen", "unix:///tmp/senpi.sock"])).toMatchObject({
			mode: "rpc",
			multiSession: true,
			listen: "unix:///tmp/senpi.sock",
		});
		expect(parseArgs(["--mode", "rpc", "--listen", "/tmp/senpi.sock"])).toMatchObject({
			multiSession: true,
			listen: "/tmp/senpi.sock",
		});
	});

	it("delivers foreign commands only after attachment, survives malformed frames, and reconnects", async () => {
		const qa = scratch("semantics");
		const fake = await startFakeModelServer();
		writeRpcModelsJson(qa.agentDir, fake.origin);
		const child = spawnRpc(
			["--mode", "rpc", "--listen", `unix://${qa.socketPath}`, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL],
			qa,
		);
		await waitForStderr(child, `senpi rpc listening on unix://${qa.socketPath}`);
		const a = await connectPeer(qa.socketPath);
		const b = await connectPeer(qa.socketPath);
		try {
			a.peer.writeMalformed("{bad first frame");
			await expect(
				a.peer.waitFor((value) => value.command === "parse" && value.success === false),
			).resolves.toMatchObject({
				type: "response",
				command: "parse",
				success: false,
			});
			await expect(b.peer.request({ id: "probe-b", type: "get_protocol_info" })).resolves.toMatchObject({
				success: true,
			});

			const opened = await a.peer.request({
				id: "open-a",
				type: "open_session",
				cwd: qa.cwd,
			});
			const sessionId = openedSessionId(opened);

			// Grace release still serves legacy callers, but records every unattached mutation (#3795).
			const grace = waitForStderr(
				child,
				`senpi rpc host: prompt on ${sessionId} from a connection not attached to it (refused from the next release)`,
			);
			const settledA = a.peer.waitFor((value) => value.type === "agent_settled" && value.sessionId === sessionId);
			await expect(
				b.peer.request({
					id: "foreign-prompt",
					type: "prompt",
					sessionId,
					message: "unique-424242",
				}),
			).resolves.toMatchObject({ success: true, sessionId });
			await settledA;
			await grace;
			expect(b.peer.messages.some((value) => value.type === "agent_settled" && value.sessionId === sessionId)).toBe(
				false,
			);

			const transcript = await b.peer.request({
				id: "foreign-transcript",
				type: "get_messages",
				sessionId,
			});
			const messages = ((transcript.data as { messages?: unknown[] }).messages ?? []).map(messageText);
			expect(messages).toContain("unique-424242");

			a.peer.writeMalformed("not-json-mid-stream");
			await a.peer.waitFor((value) => value.command === "parse" && value.success === false);
			await expect(b.peer.request({ id: "survives-mid", type: "get_state", sessionId })).resolves.toMatchObject({
				success: true,
				sessionId,
			});

			b.peer.close();
			b.socket.destroy();
			const reconnected = await connectPeer(qa.socketPath);
			try {
				await expect(
					reconnected.peer.request({
						id: "reconnected",
						type: "get_state",
						sessionId,
					}),
				).resolves.toMatchObject({ success: true, sessionId });
			} finally {
				reconnected.peer.close();
				reconnected.socket.destroy();
			}
		} finally {
			a.peer.close();
			a.socket.destroy();
			b.socket.destroy();
			await fake.close();
		}
	});
});
