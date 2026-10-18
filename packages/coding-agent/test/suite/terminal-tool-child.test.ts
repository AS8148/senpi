// senpi#3566 todo 9: a session's terminal bash runs on its tool child under --tool-runtime child (the PTY shell's
// parent is the session's child) and in this process under in-process, where nothing about it changes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolRuntimeKind } from "../../src/cli/tool-runtime.ts";
import { registerTerminalExtension } from "../../src/core/extensions/builtin/terminal/extension.ts";
import { createHarness } from "./harness.ts";

async function bashParentPid(runtime: ToolRuntimeKind): Promise<{ parent: number; row: unknown }> {
	const dir = mkdtempSync(join(tmpdir(), "ttc-"));
	const harness = await createHarness({
		cwd: dir,
		toolRuntime: runtime,
		extensionFactories: [registerTerminalExtension],
	});
	try {
		await harness.session.bindExtensions({});
		const result = await harness.session.executeTool("bash", { command: "echo parent=$PPID" });
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		const parent = Number(/parent=(\d+)/.exec(text)?.[1] ?? Number.NaN);
		if (Number.isNaN(parent)) throw new Error(`no parent pid in: ${text.slice(0, 400)}`);
		return { parent, row: harness.session.toolChildRow() };
	} finally {
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
}

describe.skipIf(process.platform === "win32")("terminal bash placement", () => {
	it("runs on the session's tool child under child", async () => {
		const { parent, row } = await bashParentPid("child");
		expect(parent).not.toBe(process.pid);
		expect(row).toMatchObject({ state: "live", pid: parent });
	}, 90_000);

	it("runs in this process under in-process, with no child", async () => {
		const { parent, row } = await bashParentPid("in-process");
		expect(parent).toBe(process.pid);
		expect(row).toEqual({ state: "none" });
	}, 90_000);
});
