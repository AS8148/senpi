// senpi#3566 todo 7: a child-run tool body calls a server tool through the reverse bridge in a real session turn. The
// server tool runs on the server, as a nested call of the child tool's call, with the session's hooks run exactly once.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createHarness, getToolResult } from "./harness.ts";

const HOOK_COUNTS = "__senpiReverseBridgeHookCounts";

const EXTENSION = `import { Type } from "typebox";
export default function (pi) {
	const counts = (globalThis["${HOOK_COUNTS}"] = {});
	pi.on("tool_call", (event) => {
		counts[event.toolName] = (counts[event.toolName] ?? 0) + 1;
	});
	pi.registerTool({
		name: "server_echo",
		label: "server echo",
		description: "answers on the server",
		parameters: Type.Object({ word: Type.String() }),
		execute: async (_id, params) => ({ content: [{ type: "text", text: "echo " + params.word }], details: { pid: process.pid } }),
	});
	pi.registerTool({
		name: "asks_host",
		label: "asks host",
		description: "calls server_echo from the tool child",
		placement: "child",
		childModule: { path: "./body.ts", export: "run" },
		parameters: Type.Object({ word: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "in-process" }], details: {} }),
	});
	pi.registerTool({
		name: "asks_completion",
		label: "asks completion",
		description: "asks the server for a completion from the tool child",
		placement: "child",
		childModule: { path: "./body.ts", export: "complete" },
		parameters: Type.Object({ word: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "in-process" }], details: {} }),
	});
}
`;

const BODY = `export async function complete(input, host) {
	const reply = await host.complete({ prompt: input.params.word });
	return { content: [{ type: "text", text: JSON.stringify(reply) }], details: { childPid: process.pid, reply } };
}

export async function run(input, host) {
	const reply = await host.call("server_echo", { word: input.params.word });
	return { content: [{ type: "text", text: "child got " + JSON.stringify(reply.result.content) }], details: { childPid: process.pid, reply } };
}
`;

async function childSession() {
	const dir = mkdtempSync(join(tmpdir(), "rb-session-"));
	const extensionDir = join(dir, "ext");
	mkdirSync(extensionDir);
	writeFileSync(join(extensionDir, "index.ts"), EXTENSION);
	writeFileSync(join(extensionDir, "body.ts"), BODY);
	const loader = new DefaultResourceLoader({
		cwd: dir,
		agentDir: join(dir, "agent"),
		settingsManager: SettingsManager.inMemory({}),
		additionalExtensionPaths: [join(extensionDir, "index.ts")],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	const harness = await createHarness({ resourceLoader: loader, cwd: dir, toolRuntime: "child" });
	await harness.session.bindExtensions({});
	return {
		harness,
		cleanup: () => {
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe.skipIf(process.platform === "win32")("reverse bridge in a session", () => {
	it("runs a server tool called from a child-run body on the server, hooks once", async () => {
		const { harness, cleanup } = await childSession();
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("asks_host", { word: "hi" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const result = getToolResult(harness, "asks_host");
			const details = result.details as {
				childPid: number;
				reply: { result: { details: { pid: number } }; isError: boolean };
			};
			expect(result.isError).toBe(false);
			expect(details.childPid).not.toBe(process.pid);
			expect(details.reply.isError).toBe(false);
			expect(details.reply.result.details.pid).toBe(process.pid);
			expect(result.content).toEqual([{ type: "text", text: 'child got [{"type":"text","text":"echo hi"}]' }]);
			expect(Reflect.get(globalThis, HOOK_COUNTS)).toEqual({ asks_host: 1, server_echo: 1 });
		} finally {
			cleanup();
		}
	}, 90_000);

	it("serves a completion call through the target registered on the session, on the server", async () => {
		const { harness, cleanup } = await childSession();
		const unregister = harness.session.registerToolChildHostTarget("completion", async (call) => ({
			answer: `completed ${String(Reflect.get(Object(call.args), "prompt"))}`,
			pid: process.pid,
		}));
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("asks_completion", { word: "ping" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("go");
			const result = getToolResult(harness, "asks_completion");
			const details = result.details as { childPid: number; reply: { answer: string; pid: number } };
			expect(result.isError).toBe(false);
			expect(details.childPid).not.toBe(process.pid);
			expect(details.reply).toEqual({ answer: "completed ping", pid: process.pid });
		} finally {
			unregister();
			cleanup();
		}
	}, 90_000);
});
