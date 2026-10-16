import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProjectContextFiles } from "../../../src/core/resource-loader.ts";
import { formatSkillsForPrompt, type Skill } from "../../../src/core/skills.ts";

const CAP = 64 * 1024;
const tempDirs: string[] = [];

function workspace(): { cwd: string; agentDir: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-3460-"));
	tempDirs.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	return { cwd, agentDir };
}

function hugeRules(bytes: number): string {
	const line = "- Rule: keep the invariants of this subsystem and record the change in the ledger.\n";
	return "# Project rules\n".concat(line.repeat(Math.ceil(bytes / line.length)));
}

describe("issue #3460: context files are size-capped so one file cannot inflate every request", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		while (tempDirs.length > 0) rmSync(tempDirs.pop() ?? "", { recursive: true, force: true });
	});

	it("truncates an oversized AGENTS.md to the cap and says so in the loaded content", () => {
		const { cwd, agentDir } = workspace();
		writeFileSync(join(cwd, "AGENTS.md"), hugeRules(360 * 1024));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const [file] = loadProjectContextFiles({ cwd, agentDir });

		expect(Buffer.byteLength(file?.content ?? "", "utf8")).toBeLessThanOrEqual(CAP + 512);
		expect(file?.content).toContain("truncated");
		expect(file?.content.startsWith("# Project rules\n")).toBe(true);
	});

	it("warns with the file path and both sizes when it truncates", () => {
		const { cwd, agentDir } = workspace();
		const path = join(cwd, "AGENTS.md");
		writeFileSync(path, hugeRules(360 * 1024));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		loadProjectContextFiles({ cwd, agentDir });

		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(path));
		expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/36\d(\.\d)? ?KiB.*64 ?KiB/));
	});

	it("leaves a file under the cap byte-identical and silent", () => {
		const { cwd, agentDir } = workspace();
		const content = hugeRules(10 * 1024);
		writeFileSync(join(cwd, "AGENTS.md"), content);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const [file] = loadProjectContextFiles({ cwd, agentDir });

		expect(file?.content).toBe(content);
		expect(consoleError).not.toHaveBeenCalled();
	});

	it("honors a configured per-file cap", () => {
		const { cwd, agentDir } = workspace();
		writeFileSync(join(cwd, "AGENTS.md"), hugeRules(40 * 1024));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const [file] = loadProjectContextFiles({ cwd, agentDir, maxBytesPerFile: 16 * 1024 });

		expect(Buffer.byteLength(file?.content ?? "", "utf8")).toBeLessThanOrEqual(16 * 1024 + 512);
	});

	it("caps the total walk-up, keeping the nearest files and naming what was cut", () => {
		const { cwd, agentDir } = workspace();
		const nested = join(cwd, "service");
		mkdirSync(nested);
		writeFileSync(join(agentDir, "AGENTS.md"), `global\n${hugeRules(60 * 1024)}`);
		writeFileSync(join(cwd, "AGENTS.md"), `project\n${hugeRules(60 * 1024)}`);
		writeFileSync(join(nested, "AGENTS.md"), `service\n${hugeRules(60 * 1024)}`);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		const files = loadProjectContextFiles({ cwd: nested, agentDir });
		const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.content, "utf8"), 0);
		const serviceFile = files.find((file) => file.path === join(nested, "AGENTS.md"));
		const projectFile = files.find((file) => file.path === join(cwd, "AGENTS.md"));

		expect(total).toBeLessThanOrEqual(128 * 1024 + 1024);
		expect(serviceFile?.content.startsWith("service\n")).toBe(true);
		expect(serviceFile?.content).not.toContain("truncated");
		expect(projectFile?.content.startsWith("project\n")).toBe(true);
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(join(agentDir, "AGENTS.md")));
	});

	it("never splits a multi-byte character at the cut point", () => {
		const { cwd, agentDir } = workspace();
		writeFileSync(join(cwd, "AGENTS.md"), "한".repeat(40 * 1024));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const [file] = loadProjectContextFiles({ cwd, agentDir, maxBytesPerFile: 16 * 1024 + 1 });

		expect(file?.content).not.toContain("\uFFFD");
	});
});

function skill(index: number, description: string): Skill {
	return {
		name: `skill-${index}`,
		description,
		filePath: `/skills/skill-${index}/SKILL.md`,
		baseDir: `/skills/skill-${index}`,
		sourceInfo: { path: `/skills/skill-${index}/SKILL.md`, source: "local", scope: "user", origin: "top-level" },
		disableModelInvocation: false,
	};
}

const LONG_DESCRIPTION =
	"Use this skill when the task involves the workflow, including setup, migration, validation, reporting, and cleanup steps.\nIt also covers every edge case of the platform, the retry rules, the logging format, and the release checklist in full detail.";

describe("issue #3460: a large skills catalog is listed compactly", () => {
	it("lists 400 skills by name with a one-line description, bounded in size", () => {
		const skills = Array.from({ length: 400 }, (_, index) => skill(index, LONG_DESCRIPTION));

		const prompt = formatSkillsForPrompt(skills);

		expect(prompt).toContain("<name>skill-399</name>");
		expect(prompt).not.toContain("retry rules");
		expect(prompt.length).toBeLessThan(100_000);
	});

	it("keeps a small catalog's full descriptions unchanged", () => {
		const skills = Array.from({ length: 10 }, (_, index) => skill(index, LONG_DESCRIPTION));

		expect(formatSkillsForPrompt(skills)).toContain("retry rules");
	});
});
