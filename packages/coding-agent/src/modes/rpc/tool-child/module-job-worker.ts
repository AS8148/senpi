// The `module` job's worker (senpi#3566 todo 4): the launch barrier is installed before the module is loaded, so every
// launch the module makes - at import time included - passes it. On Bun the module graph goes through the extension
// importer with only the child_process redirect (never loader.ts, which pulls the session writers in).
import { parentPort, workerData } from "node:worker_threads";
import { createBunExtensionImporter } from "../../../core/extensions/bun-extension-importer.ts";
import { CHILD_PROCESS_REDIRECTS, childProcessVirtualModule, GATED_CHILD_PROCESS_ID } from "./gated-modules.ts";
import { type GatedWorkerData, installWorkerBarrier } from "./gated-worker.ts";

interface ModuleWorkerData extends GatedWorkerData {
	readonly modulePath: string;
	readonly exportName: string;
	readonly args: unknown;
}

const data: ModuleWorkerData = workerData;
installWorkerBarrier(data);

async function loadNamespace(path: string): Promise<Record<string, unknown>> {
	if (Reflect.get(globalThis, "Bun") === undefined) return import(path);
	const importer = createBunExtensionImporter(
		{ [GATED_CHILD_PROCESS_ID]: childProcessVirtualModule() },
		CHILD_PROCESS_REDIRECTS,
	);
	return importer.importNamespace(path);
}

try {
	const namespace = await loadNamespace(data.modulePath);
	const target = namespace[data.exportName];
	if (typeof target !== "function") {
		parentPort?.postMessage({
			kind: "module_error",
			code: "offload_module_unavailable",
			message: `${data.modulePath} has no function export "${data.exportName}"`,
		});
	} else {
		parentPort?.postMessage({ kind: "module_result", value: await target(data.args) });
	}
} catch (error) {
	parentPort?.postMessage({
		kind: "module_error",
		code: "module_job_failed",
		message: error instanceof Error ? error.message : String(error),
	});
}
