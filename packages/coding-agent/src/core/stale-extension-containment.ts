import { hasModeCrashHandler, markBootstrapCrashListener } from "./bootstrap-crash-listeners.ts";
import { isStaleExtensionContextError } from "./extensions/builtin/goal/stale-context.ts";
import { appendDebugLogEntry } from "./hidden-stdout-log.ts";

type CrashOrigin = "uncaughtException" | "unhandledRejection";

/**
 * The runner's stale guard throws before a retired generation's operation runs, so the live session
 * must keep running: log the stack (it names the extension to fix) and stop there (oh-my-openagent#7114).
 */
export function containStaleExtensionError(error: unknown, origin: CrashOrigin): boolean {
	if (!isStaleExtensionContextError(error)) return false;
	try {
		appendDebugLogEntry(`contained stale extension ctx (${origin})`, error.stack ?? error.message);
	} catch {}
	return true;
}

function fatal(error: unknown): void {
	console.error(error);
	process.exit(1);
}

let installed = false;

/**
 * Print, RPC and host processes have no crash handler of their own, and Bun ends a process on an
 * unhandled rejection: contain a stale ctx on both channels and keep everything else fatal. Interactive
 * mode registers its own handlers, which apply the same containment first.
 */
export function installStaleExtensionContainment(): void {
	if (installed) return;
	installed = true;
	const onException = (error: Error, origin?: CrashOrigin) => {
		if (containStaleExtensionError(error, origin ?? "uncaughtException")) return;
		if (hasModeCrashHandler("uncaughtException")) return;
		fatal(error);
	};
	const onRejection = (reason: unknown) => {
		if (containStaleExtensionError(reason, "unhandledRejection")) return;
		if (hasModeCrashHandler("unhandledRejection")) return;
		fatal(reason);
	};
	markBootstrapCrashListener(onException);
	markBootstrapCrashListener(onRejection);
	process.on("uncaughtException", onException);
	process.on("unhandledRejection", onRejection);
}
