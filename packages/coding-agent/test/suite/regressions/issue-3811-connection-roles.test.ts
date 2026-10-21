import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionRoles } from "../../../src/modes/rpc/connection-roles.ts";
import { INTERACTIVE_USER_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import type { RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#3811: the interactive_user role is a property of one CONNECTION. A shared host serves every
// connection attached to a session through one binding, and only a client's own set_client_info declares it.

type Fixture = Awaited<ReturnType<typeof createIdentityHarness>>;
const fixtures: Fixture[] = [];
const directories: string[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

type Answer = { success: boolean; error?: string };

async function fixture() {
	const value = await createIdentityHarness();
	fixtures.push(value);
	return value;
}

describe("senpi#3811 connection roles", () => {
	it("lets a client declare interactive_user although the host launched with default capabilities", async () => {
		const host = await fixture();
		const connection = host.bind({ capabilities: [] });

		const declared = (await connection.send({
			type: "set_client_info",
			capabilities: [INTERACTIVE_USER_CAPABILITY],
		})) as Answer;

		expect(declared.success).toBe(true);
	});

	it("keeps each connection's role apart on one shared session binding", async () => {
		const host = await fixture();
		const roles = new ConnectionRoles();
		let current = "first";
		const binding = host.bind({
			connectionRoles: roles,
			clientInfo: { connectionId: () => current, setCapabilities: () => {} },
		});

		const first = (await binding.send({ type: "set_client_info", capabilities: [] })) as Answer;
		current = "second";
		const second = (await binding.send({
			type: "set_client_info",
			capabilities: [INTERACTIVE_USER_CAPABILITY],
		})) as Answer;

		expect([first.success, second.success]).toEqual([true, true]);
		expect(roles.has("first", INTERACTIVE_USER_CAPABILITY)).toBe(false);
		expect(roles.has("second", INTERACTIVE_USER_CAPABILITY)).toBe(true);
	});

	it("fixes the role on the host's connection-level set_client_info and frees it when the connection goes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "senpi-3811-roles-"));
		directories.push(dir);
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("client", { writeRaw: () => {}, waitForBackpressure: async () => {} });
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: async () => {
				throw new Error("no session is opened in this test");
			},
		});
		const router = new SessionCommandRouter(registry, writer, { cwd: dir }, async () => ({
			handle: async () => {},
			dispose: async () => {},
		}));
		const declare = (capabilities: string[]) =>
			writer.withConnection("client", () =>
				router.handle({ type: "set_client_info", width: 120, capabilities }),
			) as Promise<RpcResponse>;

		const plain = await declare([]);
		const flip = (await declare([INTERACTIVE_USER_CAPABILITY])) as Answer;
		await router.releaseConnection("client");
		writer.registerConnection("client", { writeRaw: () => {}, waitForBackpressure: async () => {} });
		const fresh = (await declare([INTERACTIVE_USER_CAPABILITY])) as Answer;

		expect(plain.success).toBe(true);
		expect(flip).toMatchObject({ success: false, error: expect.stringContaining("connection_role_fixed") });
		expect(fresh.success).toBe(true);
	});
});
