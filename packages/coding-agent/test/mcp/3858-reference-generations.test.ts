import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostMcpRegistry } from "../../src/core/extensions/builtin/mcp/host-registry.ts";
import { McpService } from "../../src/core/extensions/builtin/mcp/service.ts";
import { ROTATED, SECRET } from "../suite/regressions/3858-reference-support.ts";
import { capturingPi, registeredTool } from "./fixtures/register-call.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

// #3858: actual requests must follow the new snapshot, including shared renewals.
it.each([false, true])("uses rotated header bytes on reconnect (shared=%s)", async (shared) => {
	const cleanup: Array<() => Promise<void>> = [];
	const fixture = await sharingHttpFixture();
	const registry = new HostMcpRegistry();
	const service = new McpService(shared ? { mcpRegistry: registry } : {});
	try {
		const root = makeRoot("3858-generation", cleanup);
		const path = join(root.agentDir, "key");
		writeFileSync(path, SECRET, { mode: 0o600 });
		setConfig(root, {
			fx: {
				type: "http",
				url: fixture.url,
				auth: false,
				headers: { Authorization: { $file: path } },
				exposure: "direct",
			},
		});
		const pi = capturingPi();
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir },
		);
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
		const firstHash = service.getServerSnapshots()[0]?.configHash;
		await Reflect.apply(registeredTool(pi, "mcp_fx_echo").execute, undefined, ["first", {}, undefined, undefined]);
		writeFileSync(path, ROTATED);
		await service.reconnectServer("fx");
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
		await Reflect.apply(registeredTool(pi, "mcp_fx_echo").execute, undefined, ["second", {}, undefined, undefined]);
		expect(fixture.callAuthorizations).toEqual([SECRET, ROTATED]);
		expect(service.getServerSnapshots()[0]?.configHash).not.toBe(firstHash);
	} finally {
		await service.dispose("quit");
		await registry.dispose();
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});

it("isolates one invalid reference from another working server", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const fixture = await sharingHttpFixture();
	const service = new McpService();
	try {
		const root = makeRoot("3858-independent", cleanup);
		setConfig(root, {
			bad: { type: "http", url: fixture.url, headers: { Authorization: { $file: join(root.agentDir, "missing") } } },
			good: { type: "http", url: fixture.url, auth: false, exposure: "direct" },
		});
		const pi = capturingPi();
		await service.attachSession(
			{ type: "session_start", reason: "startup" },
			{ cwd: root.cwd, isProjectTrusted: () => true },
			pi,
			{ agentDir: root.agentDir },
		);
		expect(await service.whenAttachSettled(10_000)).toBe("settled");
		expect(pi.toolDefinitions.has("mcp_good_echo")).toBe(true);
		expect(service.getServerSnapshots().find((server) => server.name === "bad")?.lastError).toContain("missing");
		expect(fixture.connects).toBe(1);
	} finally {
		await service.dispose("quit");
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});
