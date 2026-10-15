import { isStaleExtensionContextError } from "./extensions/builtin/goal/stale-context.ts";
import { appendDebugLogEntry } from "./hidden-stdout-log.ts";

type CrashOrigin = "uncaughtException" | "unhandledRejection";

/**
 * The runner's stale guard throws BEFORE a retired generation's operation runs, so the live session
 * must keep running: log the stack (it names the extension to fix) and stop there (oh-my-openagent#7114).
 */
export function containStaleExtensionError(error: unknown, origin: CrashOrigin): boolean {
	if (!isStaleExtensionContextError(error)) return false;
	try {
		appendDebugLogEntry(`contained stale extension ctx (${origin})`, error.stack ?? error.message);
	} catch {}
	return true;
}

let installed = false;

/**
 * Print and RPC modes have no crash handler of their own, so this keeps every other uncaught throw
 * fatal; interactive mode prepends its handler, which applies the same containment first.
 */
export function installStaleExtensionContainment(): void {
	if (installed) return;
	installed = true;
	process.on("uncaughtException", (error) => {
		if (containStaleExtensionError(error, "uncaughtException")) return;
		if (process.listenerCount("uncaughtException") > 1) return;
		console.error(error);
		process.exit(1);
	});
}
