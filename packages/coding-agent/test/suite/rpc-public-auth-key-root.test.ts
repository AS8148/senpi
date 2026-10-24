import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHostArgs } from "../../src/cli/host-command.ts";
import { getAgentDir } from "../../src/config.ts";
import { hostRequestKeyRoot } from "../../src/modes/rpc/host-request-key-root.ts";
import { rpcKeyRoot, withRpcKeyRoot } from "../../src/modes/rpc/rpc-auth-client.ts";

afterEach(() => vi.unstubAllEnvs());

describe.skipIf(process.platform === "win32")("public RPC credential-root selection", () => {
	it("lets an explicit host flag override the environment without changing the profile", () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		const profile = getAgentDir();
		const parsed = parseHostArgs(["status", "--rpc-key-root", "/flag-root"]);
		if (typeof parsed === "string") throw new Error(parsed);
		expect(withRpcKeyRoot(parsed.keyRoot ?? "", () => rpcKeyRoot())).toBe("/flag-root");
		expect(getAgentDir()).toBe(profile);
		expect(rpcKeyRoot()).toBe("/environment-root");
	});

	it("gives explicit client options precedence over nested context and environment", () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		expect(withRpcKeyRoot("/flag-root", () => rpcKeyRoot({ keyRoot: "/client-root" }))).toBe("/client-root");
	});

	it("preserves separate roots across concurrent asynchronous operations", async () => {
		await Promise.all(
			["/root-a", "/root-b"].map((root) =>
				withRpcKeyRoot(root, async () => {
					await Promise.resolve();
					expect(rpcKeyRoot()).toBe(root);
				}),
			),
		);
	});

	// senpi#3815 review L3: `host gc --agent-dir D` dials D's endpoints with D's key records.
	it("dials a gc target with its own key root, over the environment and any enclosing root", () => {
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		const gc = { action: "gc", agentDir: "/gc-target" } as const;
		expect(hostRequestKeyRoot(gc)).toBe("/gc-target");
		expect(withRpcKeyRoot("/caller", () => hostRequestKeyRoot(gc))).toBe("/gc-target");
		expect(hostRequestKeyRoot(gc, "/flag-root")).toBe("/flag-root");
	});

	it("dials a status target from the caller's chosen root, else the target's agent dir", () => {
		const status = {
			action: "status",
			target: { socket: "/target/rpc/rpc.sock", agentDir: "/target" },
			includeWorkers: false,
			all: false,
		} as const;
		expect(hostRequestKeyRoot(status)).toBe("/target");
		vi.stubEnv("SENPI_RPC_KEY_ROOT", "/environment-root");
		expect(hostRequestKeyRoot(status)).toBe("/environment-root");
		expect(hostRequestKeyRoot(status, "/flag-root")).toBe("/flag-root");
	});
});
