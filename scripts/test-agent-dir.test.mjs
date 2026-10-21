import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { quarantineAgentDirEnv } from "./test-agent-dir.mjs";

test("quarantineAgentDirEnv replaces every inherited agent-dir lane with the run's own dir", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-dir-quarantine-"));
	try {
		const inherited = {
			OMO_CODING_AGENT_DIR: "/home/user/.omo/agent",
			SENPI_CODING_AGENT_DIR: "/home/user/.omo/agent",
			PI_CODING_AGENT_DIR: "/home/user/.pi/agent",
			UNRELATED: "keep",
		};

		const next = quarantineAgentDirEnv(inherited, root);

		assert.deepEqual(next, { UNRELATED: "keep", SENPI_CODING_AGENT_DIR: join(root, "agent") });
		assert.ok(existsSync(join(root, "agent")));
		assert.equal(inherited.OMO_CODING_AGENT_DIR, "/home/user/.omo/agent");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("quarantineAgentDirEnv leaves the env alone under SENPI_TEST_USE_REAL_AGENT_DIR=1", () => {
	const inherited = { SENPI_TEST_USE_REAL_AGENT_DIR: "1", SENPI_CODING_AGENT_DIR: "/home/user/.senpi/agent" };

	assert.equal(quarantineAgentDirEnv(inherited, "/unused"), inherited);
});
