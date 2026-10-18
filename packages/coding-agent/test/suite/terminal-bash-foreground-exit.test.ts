import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { createPtyBashTool } from "../../src/core/extensions/builtin/terminal/tools/bash.ts";
import type { TerminalToolContext } from "../../src/core/extensions/builtin/terminal/tools/context.ts";

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((block) => block.type === "text")?.text ?? "";
}

describe("terminal bash foreground exit", () => {
	let manager: TerminalManager;
	let ctx: TerminalToolContext;
	let dir: string;
	const savedForcePipe = process.env.SENPI_PTY_FORCE_PIPE;

	beforeEach(async () => {
		process.env.SENPI_PTY_FORCE_PIPE = "1";
		manager = new TerminalManager();
		ctx = {
			manager,
			cwd: process.cwd(),
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env }),
		};
		dir = await mkdtemp(join(tmpdir(), "senpi-fg-exit-"));
	});

	afterEach(async () => {
		await manager.teardown();
		if (savedForcePipe === undefined) delete process.env.SENPI_PTY_FORCE_PIPE;
		else process.env.SENPI_PTY_FORCE_PIPE = savedForcePipe;
		await rm(dir, { recursive: true, force: true });
	});

	it("a nohup background job survives a normal foreground return (the group is signalled only at a deadline, never on exit)", async () => {
		const tool = createPtyBashTool(ctx);
		const pidFile = join(dir, "bg.pid");
		// Load-bearing invariant: a NORMAL return (STARTED printed, no timeout, no abort) must
		// not signal the process group — only the deadline path ever does (PtySession::wait).
		const start = await tool.execute("fg-nohup-start", {
			command: `nohup sleep 30 >/dev/null 2>&1 & echo $! > ${pidFile}; echo STARTED`,
		});
		expect(start.isError).toBeFalsy();
		expect(firstText(start)).toContain("STARTED");

		const probe = await tool.execute("fg-nohup-probe", {
			command: `kill -0 $(cat ${pidFile}) 2>/dev/null && echo ALIVE || echo DEAD`,
		});
		expect(firstText(probe)).toContain("ALIVE");

		const cleanup = await tool.execute("fg-nohup-cleanup", {
			command: `kill $(cat ${pidFile}) 2>/dev/null; echo CLEANED`,
		});
		expect(firstText(cleanup)).toContain("CLEANED");
	});
});
