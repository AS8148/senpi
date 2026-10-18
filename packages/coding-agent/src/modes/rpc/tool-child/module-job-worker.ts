// The `module` job's worker (senpi#3566 todo 4): the launch barrier is installed before the module is loaded, so every
// launch the module makes - at import time included - passes it. On Bun the module graph goes through the extension
// importer with only the child_process redirect (never loader.ts, which pulls the session writers in).
import { parentPort, workerData } from "node:worker_threads";
import { createBunExtensionImporter } from "../../../core/extensions/bun-extension-importer.ts";
import {
	CHILD_PROCESS_REDIRECTS,
	childProcessVirtualModule,
	GATED_CHILD_PROCESS_ID,
	GATED_WORKER_THREADS_ID,
	WORKER_THREADS_REDIRECTS,
	workerThreadsVirtualModule,
} from "./gated-modules.ts";
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
		{
			[GATED_CHILD_PROCESS_ID]: childProcessVirtualModule(),
			[GATED_WORKER_THREADS_ID]: workerThreadsVirtualModule(),
		},
		{ ...CHILD_PROCESS_REDIRECTS, ...WORKER_THREADS_REDIRECTS },
	);
	return importer.importNamespace(path);
}

/** Aborted when the job is cancelled; the module sees it as `host.signal`. */
const cancellation = new AbortController();
parentPort?.on("message", (message: unknown) => {
	if (typeof message === "object" && message !== null && Reflect.get(message, "kind") === "cancel")
		cancellation.abort();
});

/** The second argument of a module export: the job's cancellation and its calls to the server (the reverse bridge). */
export interface ModuleHost {
	/** Aborts when the job is cancelled. */
	readonly signal: AbortSignal;
	/** Runs a session tool on the server (hooks once), like `ctx.executeTool`. */
	call(name: string, args: unknown): Promise<unknown>;
	/** A model completion through the session's runtime. */
	complete(args: unknown): Promise<unknown>;
	/** A reserved tool, run server-side. */
	reserved(name: string, args: unknown): Promise<unknown>;
	/** The tools callable through `call`. */
	listTools(): Promise<unknown>;
	/** The session's filesystem policy decision for one access (never cached; ask before each). */
	authorize(request: {
		operation: "read" | "enumerate" | "write";
		canonicalPath: string;
		toolName: string;
	}): Promise<{ allow: true } | { allow: false; reason: string }>;
	/**
	 * Runs `fn` holding the file's slot in the session's mutation queue - the same one its own file tools use - and
	 * releases it once `fn` settles. A cancel does not release it early: the slot passes on only after `fn` is done.
	 */
	withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
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
	const send = (hostKind: string, name: string | undefined, args: unknown) =>
		new Promise<unknown>((resolve, reject) => {
			const callId = `m${++next}`;
			pending.set(callId, { resolve, reject });
			port.postMessage({ kind: "host_call", callId, hostKind, name, args });
		});
	return {
		signal: cancellation.signal,
		call: (name, args) => send("tool", name, args),
		complete: (args) => send("completion", undefined, args),
		reserved: (name, args) => send("reserved", name, args),
		listTools: () => send("list_tools", undefined, undefined),
		authorize: (request) => send("authorize", undefined, request) as ReturnType<ModuleHost["authorize"]>,
		withFileLock: async (path, fn) => {
			const { lockId } = (await send("lock_file", undefined, { path })) as { lockId: string };
			try {
				return await fn();
			} finally {
				await send("unlock_file", undefined, { lockId });
			}
		},
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
