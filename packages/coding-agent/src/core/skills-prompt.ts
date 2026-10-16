import chalk from "chalk";
import type { Skill } from "./skills.ts";

export const COMPACT_SKILL_CATALOG_COUNT = 100;
export const COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES = 32 * 1024;
const ONE_LINE_DESCRIPTION_MAX_CHARS = 160;

/** A catalog this large is listed by name plus a one-line description, since it rides on every request. */
export function isLargeSkillCatalog(skills: readonly Skill[]): boolean {
	if (skills.length > COMPACT_SKILL_CATALOG_COUNT) return true;
	const bytes = skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.description, "utf8"), 0);
	return bytes > COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES;
}

export function warnIfLargeSkillCatalog(skills: readonly Skill[]): void {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (!isLargeSkillCatalog(visible)) return;
	console.error(
		chalk.yellow(
			`Warning: ${visible.length} skills are loaded, so each is listed with a one-line description (full lists start above ${COMPACT_SKILL_CATALOG_COUNT} skills or ${COMPACT_SKILL_CATALOG_DESCRIPTION_BYTES / 1024} KiB of descriptions). Remove unused skills to shrink every request.`,
		),
	);
}

function oneLineDescription(description: string): string {
	const firstLine = description.trim().split("\n", 1)[0]?.trim() ?? "";
	return firstLine.length <= ONE_LINE_DESCRIPTION_MAX_CHARS
		? firstLine
		: `${firstLine.slice(0, ONE_LINE_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses XML format per Agent Skills standard.
 * See: https://agentskills.io/integrate-skills
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 */
// Skill roots share long absolute prefixes across every skill under them; rendering
// that prefix per skill bills it once per skill. The roots table pays it once per
// distinct root and each location becomes a short alias/relative path. A one-line
// rule tells the model to expand aliases by joining them back to the root.
// `fileReadTool` lets a bash-only tool set still load skills: the loading rule names
// the tool the session actually has.
export function formatSkillsForPrompt(skills: Skill[], fileReadTool: "read" | "bash" = "read"): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

	if (visibleSkills.length === 0) {
		return "";
	}

	const rootByPath = new Map<string, string>();
	const compact = isLargeSkillCatalog(visibleSkills);
	for (const skill of visibleSkills) {
		const dir = skill.filePath.split("/").slice(0, -2).join("/"); // parent of <name>/SKILL.md
		if (!rootByPath.has(dir)) rootByPath.set(dir, `r${rootByPath.size}`);
	}

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when its description matches the task and its instructions would change the work; keyword overlap or mere availability is not a reason."
			: "Use bash to load a skill's file when its description matches the task and its instructions would change the work; keyword overlap or mere availability is not a reason.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<skill_roots>",
	];
	for (const [dir, alias] of rootByPath) {
		lines.push(`  <${alias}>${escapeXml(dir)}</${alias}>`);
	}
	lines.push(
		"</skill_roots>",
		"A location's `rN/` prefix expands to the matching root above.",
		"",
		"<available_skills>",
	);

	for (const skill of visibleSkills) {
		const dir = skill.filePath.split("/").slice(0, -2).join("/");
		const alias = rootByPath.get(dir);
		const relative = skill.filePath.startsWith(`${dir}/`) ? skill.filePath.slice(dir.length + 1) : skill.filePath;
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(
			`    <description>${escapeXml(compact ? oneLineDescription(skill.description) : skill.description)}</description>`,
		);
		lines.push(`    <location>${escapeXml(`${alias}/${relative}`)}</location>`);
		lines.push("  </skill>");
	}

	lines.push("</available_skills>");

	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
