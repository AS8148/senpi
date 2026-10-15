import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createMessagePathLinkTransformer } from "../../../src/modes/interactive/components/message-path-links.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repository() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-3415-links-")));
	dirs.push(root);
	mkdirSync(join(root, ".git"));
	const cwd = join(root, "packages", "app");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(root, "docs"));
	writeFileSync(join(root, "docs", "plan.md"), "plan");
	return { root, cwd };
}

const context = { messageType: "assistant" as const, isStreaming: false, availableWidth: 80 };

describe("message path links in the TUI (#3415)", () => {
	it("points a relative link at the file the project root holds", () => {
		const { root, cwd } = repository();
		const transform = createMessagePathLinkTransformer(() => cwd);
		const url = pathToFileURL(join(root, "docs", "plan.md")).href;
		expect(transform("See [the plan](docs/plan.md#goals).", context)).toBe(`See [the plan](${url}#goals).`);
	});

	it("leaves URLs, anchors, missing files and code alone", () => {
		const { cwd } = repository();
		const transform = createMessagePathLinkTransformer(() => cwd);
		const markdown = [
			"[site](https://example.com) [top](#intro) [gone](docs/missing.md)",
			"`[code](docs/plan.md)`",
			"```",
			"[fenced](docs/plan.md)",
			"```",
		].join("\n");
		expect(transform(markdown, context)).toBe(markdown);
	});
});
