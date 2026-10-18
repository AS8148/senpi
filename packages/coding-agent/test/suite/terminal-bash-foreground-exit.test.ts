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

	beforeEach(async () => {
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
		await rm(dir, { recursive: true, force: true });
	});

	it("nothing signals a normally-returning foreground job's process group: a ready nohup child stays alive across the call", async () => {
		const tool = createPtyBashTool(ctx);
		const ready = join(dir, "ready");
		const pidFile = join(dir, "bg.pid");
		// The readiness file only exists after the nohup'd child is running with SIGHUP
		// ignored, so the shell exiting cannot race the ignore into a kill. On the native
		// backend the PTY hangup then provably spares it; on the pipe fallback (no PTY, no
		// hangup) the assertion guards the other half of the contract: a normal return must
		// never signal the group — only the timeout path ever kills it.
		const start = await tool.execute("fg-nohup-start", {
			command: `nohup sh -c 'touch ${ready}; exec sleep 30' >/dev/null 2>&1 & echo $! > ${pidFile}; until test -f ${ready}; do sleep 0.05; done; echo STARTED`,
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
