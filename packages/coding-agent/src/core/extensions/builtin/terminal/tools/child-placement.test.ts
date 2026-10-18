// senpi#3566 todo 9: a background session lives on the tool child generation that started it; a later call that reaches
// a new generation reports the session lost instead of the child's "unknown id".
import { describe, expect, it } from "vitest";
import { TERMINAL_CHILD_JOB_KINDS, type TerminalSessionGenerations, terminalChildJob } from "./child-placement.ts";
import type { TerminalToolContext } from "./context.ts";

const ctx = {} as TerminalToolContext;
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

describe("terminal child job result", () => {
	it("records the generation a background session started on and reports it lost on a later generation", () => {
		const generations: TerminalSessionGenerations = new Map();
		const bash = terminalChildJob(ctx, TERMINAL_CHILD_JOB_KINDS.bash, generations);
		const output = terminalChildJob(ctx, TERMINAL_CHILD_JOB_KINDS.output, generations);
		bash.result?.(
			{ command: "sleep 100", run_in_background: true },
			{ content: [], details: { bash_id: "b1", background: true } },
			1,
		);
		expect(generations.get("b1")).toBe(1);

		const same = text("still running");
		expect(output.result?.({ bash_id: "b1" }, same, 1)).toBe(same);

		const lost = output.result?.({ bash_id: "b1" }, text("unknown bash_id b1"), 2);
		expect(lost?.details).toEqual({ bash_id: "b1", lost: true, generation: 1 });
		expect(lost?.content[0]).toMatchObject({ type: "text" });
		expect(generations.has("b1")).toBe(false);
	});

	it("passes through results for ids it never saw and for calls without an id", () => {
		const generations: TerminalSessionGenerations = new Map();
		const kill = terminalChildJob(ctx, TERMINAL_CHILD_JOB_KINDS.kill, generations);
		const value = text("unknown bash_id zz");
		expect(kill.result?.({ bash_id: "zz" }, value, 3)).toBe(value);
		expect(kill.result?.({ all: true }, value, 3)).toBe(value);
	});
});
