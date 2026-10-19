import { runToolChild, type ToolChildJobHandler } from "./entry.ts";
import { createModuleJobHandler, MODULE_JOB_KIND } from "./module-job.ts";

/** Job kinds the production tool child serves; each later migration registers its kind here. */
export const TOOL_CHILD_JOB_HANDLERS: Readonly<Record<string, ToolChildJobHandler>> = {
	[MODULE_JOB_KIND]: createModuleJobHandler(),
};

export async function runToolChildRole(): Promise<never> {
	await runToolChild({ handlers: TOOL_CHILD_JOB_HANDLERS });
	process.exit(0);
}
