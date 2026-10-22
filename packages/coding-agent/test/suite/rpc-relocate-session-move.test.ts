/**
 * An accepted relocation end to end on a REAL in-process host (router, registry, binding, `AgentSession`): the agent
 * asks mid-turn, the turn runs to its end, `relocation_due` follows, and the host's ordinary `release_session` reason
 * `move` plus `move_session export` end this runtime cleanly with the move recorded under the session's own id.
 */
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import relocateSessionExtension from "../../src/core/extensions/builtin/relocate-session/index.ts";
import { afterReleased, startReleaseHost } from "./rpc-release-host-support.ts";

type WireRecord = Record<string, unknown> & { readonly type?: string; readonly id?: string };

describe("relocate_session success on a real host", () => {
	it("ends this runtime cleanly with the move recorded; id and conversation stay with the thread", async () => {
		// Given: a host that offers relocation and accepts a move to Studio as mv-a1.
		let due: (record: WireRecord) => void = () => {};
		const dueSeen = new Promise<WireRecord>((resolve) => {
			due = resolve;
		});
		let answer: (record: WireRecord) => void = () => {};
		await using host = await startReleaseHost(relocateSessionExtension, {
			capabilities: ["session_relocation"],
			onRecord: (record) => {
				if (record.type === "host_request") answer(record);
				if (record.type === "relocation_due") due(record);
			},
		});
		answer = (record) =>
			void host.send({
				type: "host_response",
				id: String(record.id),
				sessionId: String(record.sessionId),
				data: { accepted: true, moveId: "mv-a1", target: "Studio" },
			} as never);
		host.faux.setResponses([
			fauxAssistantMessage("seed reply"),
			fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Studio", reason: "heavy build" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("handing over to Studio"),
		]);
		const { sessionId, sessionPath, session } = await host.open("relocating");
		const durableId = session.sessionId;

		// When: the agent asks mid-turn; once the turn ends the host runs the existing move steps.
		await host.send({ type: "prompt", id: "work", sessionId, message: "run the heavy build" });
		const notice = await dueSeen;
		const released = await host.send({
			type: "release_session",
			id: "rel",
			sessionId,
			reason: "move",
			moveId: "mv-a1",
			target: "Studio",
		});
		const exported = await host.send({
			type: "move_session",
			id: "exp",
			op: "export",
			sessionPath,
			moveId: "mv-a1",
			target: "Studio",
		} as never);

		// Then: the due notice named the move; the release sealed it with nothing after; the export carries the id.
		expect(notice).toMatchObject({ sessionId, moveId: "mv-a1", target: "Studio" });
		expect(released).toMatchObject({ success: true, data: { released: true } });
		expect(afterReleased(sessionPath)).toEqual([]);
		const file = readFileSync(sessionPath, "utf8");
		expect(file).toContain("run the heavy build");
		expect(file).toContain("handing over to Studio");
		const seal = file
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { customType?: string; data?: Record<string, unknown> })
			.find((entry) => entry.customType === "session_released");
		expect(seal?.data).toMatchObject({ reason: "move", move_id: "mv-a1", target: "Studio", session_id: durableId });
		expect(exported).toMatchObject({ success: true, data: { move_id: "mv-a1", session_id: durableId } });
		expect(await host.send({ type: "get_state", id: "after", sessionId })).toMatchObject({
			success: false,
			error: expect.stringContaining("unknown_session"),
		});
	});
});
