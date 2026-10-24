import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { isRecord } from "../../src/core/extensions/builtin/mcp/modern/form-schema.ts";
import { McpPresenterControl } from "../../src/modes/rpc/mcp-presenter-control.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { bootstrapRelayProbe } from "./fixtures/presenter-bootstrap-relay.ts";

it.each(["node", "bun"])(
	"the %s child keeps bootstrap fd 4 separate from owner fd 3",
	async (runtime) => {
		await bootstrapRelayProbe(runtime);
	},
	20_000,
);
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

function records(socket: Socket) {
	const queued: Record<string, unknown>[] = [];
	const waiters: Array<(value: Record<string, unknown>) => void> = [];
	const detach = attachJsonlLineReader(socket, (line) => {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) throw new Error("Expected a private record");
		const waiter = waiters.shift();
		if (waiter) waiter(value);
		else queued.push(value);
	});
	return {
		send: (value: object) => socket.write(`${JSON.stringify(value)}\n`),
		next: () => {
			const value = queued.shift();
			return value
				? Promise.resolve(value)
				: new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
		},
		detach,
	};
}

it("only protected enrollment and a scope-bound signature can acquire; replay cannot", async () => {
	const root = await mkdtemp(join(tmpdir(), "pgr-"));
	const writer = new SessionEventWriter(() => {});
	const authority = writer.enableMcpPresenters();
	writer.registerConnection("human", { writeRaw: () => {}, waitForBackpressure: async () => {} });
	writer.bindMcpForms("session", "durable", {}, () => {});
	writer.attachConnectionToSession("human", "session");
	const binding = writer.getMcpFormBinding("session");
	const connection = writer.getMcpPresenterConnection("human");
	if (!binding || !connection) throw new Error("Fixture binding missing");
	const context = authority.connectionContext(connection, "session");
	const control = new McpPresenterControl(
		writer,
		process.platform === "win32" ? `\\\\.\\pipe\\presenter-test-${randomUUID()}` : join(root, "c.sock"),
	);
	await control.listen();
	const bootstrapServer = createServer((socket) => control.bootstrap(socket));
	bootstrapServer.listen(0, "127.0.0.1");
	await once(bootstrapServer, "listening");
	const address = bootstrapServer.address();
	if (typeof address !== "object" || !address) throw new Error("Bootstrap listener missing");
	const bootstrap = connect(address.port, "127.0.0.1");
	const b = records(bootstrap);
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	let management: Socket | undefined;
	try {
		b.send({
			type: "enroll",
			publicKey: publicKey.export({ type: "spki", format: "pem" }),
			backendGeneration: "backend",
		});
		const challenge = await b.next();
		if (typeof challenge.transcript !== "string") throw new Error("Missing challenge");
		b.send({ type: "proof", signature: sign(null, Buffer.from(challenge.transcript), privateKey).toString("hex") });
		const enrolled = await b.next();
		expect(enrolled.type).toBe("enrolled");
		expect(binding.capture()).toBeUndefined();
		management = connect(control.path);
		let m = records(management);
		m.send({
			type: "challenge",
			principalId: enrolled.principalId,
			backendGeneration: "backend",
			command: {
				type: "mcp_presenter_acquire",
				id: "acquire",
				...context,
				sessionId: "session",
				kind: "desktop",
				purpose: "mcp_form",
			},
		});
		const grantChallenge = await m.next();
		if (typeof grantChallenge.transcript !== "string") throw new Error("Missing grant challenge");
		const proof = {
			type: "proof",
			signature: sign(null, Buffer.from(grantChallenge.transcript), privateKey).toString("hex"),
		};
		m.send(proof);
		expect(await m.next()).toMatchObject({ type: "mcp_presenter_acquired", id: "acquire" });
		expect(binding.capture()?.ready()).toBe(true);
		management = connect(control.path);
		m = records(management);
		m.send({
			type: "challenge",
			principalId: enrolled.principalId,
			backendGeneration: "replacement",
			command: {
				type: "mcp_presenter_acquire",
				id: "replacement",
				...context,
				sessionId: "session",
				kind: "desktop",
				purpose: "mcp_form",
			},
		});
		const replacement = await m.next();
		if (typeof replacement.transcript !== "string") throw new Error("Missing replacement challenge");
		const replacementProof = {
			type: "proof",
			signature: sign(null, Buffer.from(replacement.transcript), privateKey).toString("hex"),
		};
		m.send(replacementProof);
		expect(await m.next()).toMatchObject({ type: "mcp_presenter_acquired", id: "replacement" });
		expect(binding.capture()?.ready()).toBe(true);
		const closed = once(management, "close");
		m.send(replacementProof);
		await closed;
		expect(binding.capture()).toBeUndefined();
		m.detach();
	} finally {
		b.detach();
		bootstrap.destroy();
		management?.destroy();
		control.dispose();
		await new Promise<void>((resolve, reject) =>
			bootstrapServer.close((error) => (error ? reject(error) : resolve())),
		);
		await rm(root, { recursive: true, force: true });
	}
});
