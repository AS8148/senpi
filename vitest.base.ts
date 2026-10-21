import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { quarantineAgentDirEnv } from "./scripts/test-agent-dir.mjs";

// A Vitest started without scripts/run-tests.mjs (the codemode gate) still quarantines the agent dir
// before forking workers, so every worker and the kernels they spawn inherit it (senpi#3867).
const inheritedAgentDirs = Object.entries(process.env).filter(([key]) => key.endsWith("_CODING_AGENT_DIR"));
const alreadyQuarantined =
	process.env.SENPI_TEST_AGENT_DIR_GUARD === "1" &&
	inheritedAgentDirs.every(([, dir]) => dir?.startsWith(tmpdir() + sep) === true);
if (!alreadyQuarantined) {
	const agentRoot = mkdtempSync(join(tmpdir(), "senpi-vitest-agent-"));
	process.once("exit", () => rmSync(agentRoot, { recursive: true, force: true }));
	const quarantined = quarantineAgentDirEnv(process.env, agentRoot);
	for (const key of Object.keys(process.env)) if (!(key in quarantined)) delete process.env[key];
	Object.assign(process.env, quarantined);
}

export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordBundler: fileURLToPath(new URL("./packages/chord/src/bundler.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiAuthPool: fileURLToPath(new URL("./packages/ai/src/auth", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent/src/node.ts", import.meta.url)),
	protocolIndex: fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
	clientIndex: fileURLToPath(new URL("./packages/client/src/index.ts", import.meta.url)),
	clientUnix: fileURLToPath(new URL("./packages/client/src/unix.ts", import.meta.url)),
	serverIndex: fileURLToPath(new URL("./packages/server/src/index.ts", import.meta.url)),
	serverUnix: fileURLToPath(new URL("./packages/server/src/transports/unix/index.ts", import.meta.url)),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@earendil-works\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@earendil-works\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@earendil-works\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@earendil-works\/chord\/bundler$/, replacement: workspaceSourcePaths.chordBundler },
			{ find: /^@earendil-works\/chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@earendil-works\/pi-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@earendil-works\/pi-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@earendil-works\/pi-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@earendil-works\/pi-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{
				find: /^@earendil-works\/pi-ai\/auth\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiAuthPool}/$1.ts`,
			},
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@earendil-works\/pi-agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{ find: /^@earendil-works\/pi-protocol$/, replacement: workspaceSourcePaths.protocolIndex },
			{ find: /^@earendil-works\/pi-client$/, replacement: workspaceSourcePaths.clientIndex },
			{ find: /^@earendil-works\/pi-client\/unix$/, replacement: workspaceSourcePaths.clientUnix },
			{ find: /^@earendil-works\/pi-server$/, replacement: workspaceSourcePaths.serverIndex },
			{ find: /^@earendil-works\/pi-server\/unix$/, replacement: workspaceSourcePaths.serverUnix },
			{ find: /^@earendil-works\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
		],
	},
});
