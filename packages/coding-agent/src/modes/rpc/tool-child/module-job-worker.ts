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

/** The second argument of a module export: calls to the server for this job (the reverse bridge). */
export interface ModuleHost {
	call(tool: string, args: unknown): Promise<unknown>;
}

function createModuleHost(): ModuleHost {
	const port = parentPort;
	if (port === null) throw new Error("module job worker without a parent port");
	const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	let next = 0;
	port.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null || Reflect.get(message, "kind") !== "host_reply") return;
		const callId = String(Reflect.get(message, "callId"));
		const call = pending.get(callId);
		if (call === undefined) return;
		pending.delete(callId);
		const error = Reflect.get(message, "error");
		if (typeof error === "string")
			call.reject(Object.assign(new Error(error), { code: Reflect.get(message, "code") }));
		else call.resolve(Reflect.get(message, "value"));
	});
	return {
		call: (tool, args) =>
			new Promise((resolve, reject) => {
				const callId = `m${++next}`;
				pending.set(callId, { resolve, reject });
				port.postMessage({ kind: "host_call", callId, tool, args });
			}),
	};
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
		parentPort?.postMessage({ kind: "module_result", value: await target(data.args, createModuleHost()) });
	}
} catch (error) {
	parentPort?.postMessage({
		kind: "module_error",
		code: "module_job_failed",
		message: error instanceof Error ? error.message : String(error),
	});
}
