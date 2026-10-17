/**
 * Process-wide replacement of `node:child_process` for extension code (senpi#3566, plan todo 4).
 *
 * The Bun extension importer resolves `node:child_process` / `child_process` - in an extension and in every module of
 * its graph, transitive dependencies included - to the virtual id below, which serves whatever module this process
 * installed. The server installs nothing, so extensions there get the real module, exactly as before. A tool child
 * installs the gated module before any extension loads, so a named import there passes the execution barrier too.
 * Bun forbids overriding the builtin's own name, which is why the redirect goes to a separate id.
 */
import realChildProcess from "node:child_process";

export const GATED_CHILD_PROCESS_ID = "senpi-tool-child:child_process";

export const CHILD_PROCESS_REDIRECTS: Readonly<Record<string, string>> = {
	"node:child_process": GATED_CHILD_PROCESS_ID,
	child_process: GATED_CHILD_PROCESS_ID,
};

let installed: typeof realChildProcess = realChildProcess;

export function installChildProcessModule(module: typeof realChildProcess): void {
	installed = module;
}

/**
 * The module object the virtual id serves. Bun snapshots an object module's named exports when it is first loaded, so
 * every function export forwards to the module installed at call time; non-function exports are copied once.
 */
export function childProcessVirtualModule(): Readonly<Record<string, unknown>> {
	const exports: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(realChildProcess)) {
		exports[name] =
			typeof value === "function"
				? (...args: unknown[]) => Reflect.apply(Reflect.get(installed, name), installed, args)
				: value;
	}
	exports.default = exports;
	return exports;
}
