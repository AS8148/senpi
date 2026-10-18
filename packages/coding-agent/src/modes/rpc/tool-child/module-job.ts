/**
 * The `module` job kind (senpi#3566, plan todo 4; the contract todo 8's `ctx.offload` reuses unchanged).
 *
 * Wire shape: `{ modulePath, export, args }`. The child loads `modulePath` in a gated job worker and calls the named
 * export with `args`; the result must be structured-cloneable. `modulePath` must resolve - after realpath - inside one
 * of the installed extension directories the server granted this child at spawn (`SENPI_TOOL_CHILD_MODULE_ROOTS`), so a
 * job can never name an arbitrary file.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ToolChildJobContext } from "./entry.ts";
import { ToolChildJobError } from "./entry.ts";
import { siblingWorkerUrl, startGatedWorker } from "./gated-worker.ts";

export const MODULE_JOB_KIND = "module";
export const TOOL_CHILD_MODULE_ROOTS_ENV = "SENPI_TOOL_CHILD_MODULE_ROOTS";

export interface ModuleJobArgs {
	readonly modulePath: string;
	readonly export: string;
	readonly args: unknown;
}

export function parseModuleJobArgs(value: unknown): ModuleJobArgs {
	if (typeof value !== "object" || value === null)
		throw new ToolChildJobError("module_job_invalid", "args must be an object");
	const modulePath = Reflect.get(value, "modulePath");
	const exportName = Reflect.get(value, "export");
	if (typeof modulePath !== "string" || !isAbsolute(modulePath))
		throw new ToolChildJobError("module_job_invalid", "modulePath must be an absolute path");
	if (typeof exportName !== "string" || exportName.length === 0)
		throw new ToolChildJobError("module_job_invalid", "export must be a non-empty string");
	return { modulePath, export: exportName, args: Reflect.get(value, "args") };
}

export function parseModuleRoots(env: NodeJS.ProcessEnv): readonly string[] {
	const raw = env[TOOL_CHILD_MODULE_ROOTS_ENV];
	if (raw === undefined || raw === "") return [];
	const parsed: unknown = JSON.parse(raw);
	if (!Array.isArray(parsed) || !parsed.every((root) => typeof root === "string" && isAbsolute(root)))
		throw new ToolChildJobError(
			"module_job_invalid",
			`${TOOL_CHILD_MODULE_ROOTS_ENV} must be a JSON array of absolute paths`,
		);
	return parsed;
}

function realpathOrUndefined(path: string): string | undefined {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** The module's realpath when it lies inside a granted root (both sides realpath'd); otherwise a typed refusal. */
export function containedModulePath(modulePath: string, roots: readonly string[]): string {
	const resolved = realpathOrUndefined(modulePath);
	if (resolved === undefined)
		throw new ToolChildJobError("offload_module_unavailable", `${modulePath} does not exist`);
	for (const root of roots) {
		const realRoot = realpathOrUndefined(root);
		if (realRoot === undefined) continue;
		const inside = relative(realRoot, resolved);
		if (inside !== "" && !inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside)) return resolved;
	}
	throw new ToolChildJobError(
		"module_job_outside_roots",
		`${modulePath} is not inside an installed extension directory`,
	);
}

export function createModuleJobHandler(env: NodeJS.ProcessEnv = { ...process.env }) {
	return async (value: unknown, context: ToolChildJobContext): Promise<unknown> => {
		const job = parseModuleJobArgs(value);
		const modulePath = containedModulePath(job.modulePath, parseModuleRoots(env));
		const worker = startGatedWorker(
			context.gate,
			siblingWorkerUrl("./module-job-worker.ts", import.meta.url),
			context.jobId,
			{
				workerData: { modulePath, exportName: job.export, args: job.args },
			},
		);
		const abort = () => void worker.terminate();
		context.signal.addEventListener("abort", abort, { once: true });
		try {
			return await new Promise((resolve, reject) => {
				worker.on("message", (message: unknown) => {
					if (typeof message !== "object" || message === null) return;
					const kind = Reflect.get(message, "kind");
					if (kind === "module_result") resolve(Reflect.get(message, "value"));
					else if (kind === "module_error")
						reject(
							new ToolChildJobError(
								String(Reflect.get(message, "code")),
								String(Reflect.get(message, "message")),
							),
						);
				});
				worker.once("error", (error: unknown) =>
					reject(
						new ToolChildJobError("module_job_failed", error instanceof Error ? error.message : String(error)),
					),
				);
				worker.once("exit", (code) =>
					reject(new ToolChildJobError("module_job_failed", `worker exited (${code})`)),
				);
			});
		} finally {
			context.signal.removeEventListener("abort", abort);
			void worker.terminate();
		}
	};
}
