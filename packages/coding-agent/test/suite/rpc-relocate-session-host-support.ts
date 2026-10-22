/**
 * A REAL in-process host (router, registry, binding, `AgentSession`) with the relocation extension, a desktop client
 * that offers `session_relocation` and stays attached, and a scripted turn in which the agent asks to move to Studio.
 */
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import relocateSessionExtension from "../../src/core/extensions/builtin/relocate-session/index.ts";
import { startReleaseHost } from "./rpc-release-host-support.ts";

export type WireRecord = Record<string, unknown> & { readonly type?: string; readonly id?: string };
export const DESKTOP = "desktop";
export const OFFERS = ["session_relocation"];
export const ACCEPT = { accepted: true, moveId: "mv-a1", target: "Studio" };

export interface RelocationHostOptions {
	/** Attaches before the turn; `capabilities` absent = an older client that never offers relocation. */
	readonly otherClient?: { readonly name: string; readonly capabilities?: readonly string[] };
	/** Who answers each `host_request`: the desktop accepts by default. */
	readonly answer?: (request: WireRecord, reply: (connection: string, data: unknown) => void) => void;
}

export async function relocationHost(options: RelocationHostOptions = {}) {
	const received: Array<{ readonly connection: string | undefined; readonly record: WireRecord }> = [];
	let due: (record: WireRecord) => void = () => {};
	const dueSeen = new Promise<WireRecord>((resolve) => {
		due = resolve;
	});
	let onRequest: (record: WireRecord) => void = () => {};
	const host = await startReleaseHost(relocateSessionExtension, {
		onRecord: (record, connection) => {
			received.push({ connection, record });
			if (record.type === "host_request") onRequest(record);
			if (record.type === "relocation_due") due(record);
		},
	});
	const replies: WireRecord[] = [];
	const reply = (connection: string, record: WireRecord, data: unknown): void =>
		void host
			.send(
				{ type: "host_response", id: String(record.id), sessionId: String(record.sessionId), data } as never,
				connection,
			)
			.then((answer) => replies.push(answer));
	onRequest = (record) =>
		options.answer
			? options.answer(record, (connection, data) => reply(connection, record, data))
			: reply(DESKTOP, record, ACCEPT);
	host.faux.setResponses([
		fauxAssistantMessage("seed reply"),
		fauxAssistantMessage([fauxToolCall("relocate_session", { target: "Studio", reason: "heavy build" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("handing over to Studio"),
	]);
	const opened = await host.open("relocating");
	await host.attach(opened.sessionPath, DESKTOP, OFFERS);
	if (options.otherClient)
		await host.attach(opened.sessionPath, options.otherClient.name, options.otherClient.capabilities);
	const work = () =>
		host.send({ type: "prompt", id: "work", sessionId: opened.sessionId, message: "run the heavy build" }, DESKTOP);
	const release = () =>
		host.send(
			{
				type: "release_session",
				id: "rel",
				sessionId: opened.sessionId,
				reason: "move",
				moveId: "mv-a1",
				target: "Studio",
			},
			DESKTOP,
		);
	const recordsOn = (connection: string, type: string) =>
		received
			.filter((entry) => entry.connection === connection && entry.record.type === type)
			.map((entry) => entry.record);
	return { host, dueSeen, work, release, recordsOn, replies, ...opened };
}
