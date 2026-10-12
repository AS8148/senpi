import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideAuto } from "../../src/core/extensions/builtin/permission-system/auto-policy.ts";
import { PERMISSION_PRESET_NAMES } from "../../src/core/extensions/builtin/permission-system/cli.ts";
import { rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import type { Action } from "../../src/core/extensions/builtin/permission-system/types.ts";

// senpi#3210: an eval cell is arbitrary code. Under every preset the eval call itself must be at
// least as restricted as the strictest direct tool that performs the same kinds of side effect
// (shell, file edit, file write), so no preset can be bypassed by wrapping an action in a cell.

const STRICTNESS: Record<Action, number> = { allow: 0, ask: 1, deny: 2 };

let project = "";

beforeAll(() => {
	project = mkdtempSync(join(tmpdir(), "senpi-eval-floor-"));
	mkdirSync(join(project, ".git"), { recursive: true });
	writeFileSync(join(project, "notes.txt"), "notes\n");
});

afterAll(() => {
	rmSync(project, { recursive: true, force: true });
});

function decisionFor(
	preset: (typeof PERMISSION_PRESET_NAMES)[number],
	toolName: string,
	input: Record<string, unknown>,
): Action {
	const registry = createBuiltinParserRegistry();
	const requests = registry.parse(toolName, input, project);
	return requests
		.map((request) => evaluate(request.permission, request.patterns, rulesForPreset(preset)).action)
		.reduce<Action>(
			(strictest, action) => (STRICTNESS[action] > STRICTNESS[strictest] ? action : strictest),
			"allow",
		);
}

describe("eval is never looser than shell, edit or write (senpi#3210)", () => {
	it.each(PERMISSION_PRESET_NAMES)("under the %s preset", (preset) => {
		// given
		const direct = [
			decisionFor(preset, "bash", { command: "mkdir build-out" }),
			decisionFor(preset, "edit", { path: join(project, "notes.txt"), oldText: "notes", newText: "n" }),
			decisionFor(preset, "write", { path: join(project, "new.txt"), content: "x" }),
		];
		const strictestDirect = Math.max(...direct.map((action) => STRICTNESS[action]));

		// when
		const evalAction = decisionFor(preset, "eval", { language: "js", code: "require('node:fs').mkdirSync('x')" });

		// then
		expect(STRICTNESS[evalAction]).toBeGreaterThanOrEqual(strictestDirect);
	});

	it("the auto preset's judge never approves an eval cell, whatever its code", async () => {
		// given
		const cells = ["require('node:fs').mkdirSync('build-out')", "await tool.read({ path: 'notes.txt' })", "return 1"];

		// when
		const decisions = await Promise.all(
			cells.map((code) =>
				decideAuto(
					"eval",
					{ language: "js", code },
					{ permission: "eval", patterns: ["*"], always: ["*"] },
					project,
				),
			),
		);

		// then
		expect(decisions.every((decision) => decision.approveBlanketAsk === false)).toBe(true);
	});
});
