/**
 * One session's tool child (senpi#3566, plan todo 4). The child starts on the first job routed to it, never earlier;
 * a dead child is started again (a new generation) by the next job. Status is the minimal row todo 14 extends:
 * `session_tool_child{state: "spawned" | "exited" | "respawned", generation, pid}` records and the `list_sessions`
 * row `tool_child: {state: "none" | "live" | "exited", generation?, pid?}`.
 */
import { dirname, isAbsolute, resolve } from "node:path";
import type { RegisteredTool } from "../../../core/extensions/types.ts";
import type {
	ToolChildModuleJob,
	ToolChildRunner,
	ToolChildRunResult,
} from "../../../core/tool-dispatch/tool-dispatcher.ts";
import { ToolChildClient, type ToolChildStatus } from "./client.ts";
import type { ToolChildCommand } from "./launch.ts";
import { MODULE_JOB_KIND, TOOL_CHILD_MODULE_ROOTS_ENV } from "./module-job.ts";

export interface SessionToolChildRecord {
	readonly state: "spawned" | "exited" | "respawned";
	readonly generation: number;
	readonly pid: number;
}

export interface SessionToolChildRow {
	readonly state: "none" | "live" | "exited";
	readonly generation?: number;
	readonly pid?: number;
}

export interface SessionToolChildOptions {
	readonly dir: string;
	readonly cwd: string;
	/** Installed extension directories the child may load `module` jobs from, read at every spawn. */
	readonly moduleRoots: () => readonly string[];
	readonly onRecord: (record: SessionToolChildRecord) => void;
	readonly env?: NodeJS.ProcessEnv;
	readonly command?: ToolChildCommand;
}

/** The directories of the extensions whose tools declare a `childModule`: the only places a `module` job may load from. */
export function toolChildModuleRoots(tools: readonly RegisteredTool[]): readonly string[] {
	// Exactly the files tools declared, never their directory: a single-file extension in a broad directory (a project
	// root, `extensions/`) would otherwise grant every module beside it.
	return [
		...new Set(
			tools.flatMap((tool) => {
				const childModule = tool.definition.childModule;
				if (childModule === undefined || tool.sourceInfo.path.startsWith("<")) return [];
				return [
					isAbsolute(childModule.path)
						? childModule.path
						: resolve(dirname(tool.sourceInfo.path), childModule.path),
				];
			}),
		),
	];
}

export class SessionToolChild {
	readonly #options: SessionToolChildOptions;
	readonly #client: ToolChildClient;
	#starting: Promise<void> | undefined;
	#last: { readonly generation: number; readonly pid: number } | undefined;
	#closed = false;

	constructor(options: SessionToolChildOptions) {
		this.#options = options;
		this.#client = new ToolChildClient({
			dir: options.dir,
			cwd: options.cwd,
			env: () => ({
				...(options.env ?? process.env),
				[TOOL_CHILD_MODULE_ROOTS_ENV]: JSON.stringify(options.moduleRoots()),
			}),
			...(options.command === undefined ? {} : { command: options.command }),
			onStatus: (status) => this.#onStatus(status),
		});
	}

	readonly runner: ToolChildRunner = async (job: ToolChildModuleJob, signal: AbortSignal | undefined) => {
		await this.#ensureLive();
		const generation = this.#client.generation;
		const pid = this.#client.pid ?? -1;
		const value = await this.#client.run(MODULE_JOB_KIND, job, signal);
		return { value, pid, generation } satisfies ToolChildRunResult;
	};

	row(): SessionToolChildRow {
		const state = this.#client.state;
		if (this.#last === undefined) return { state: "none" };
		if (state === "live") return { state: "live", generation: this.#client.generation, pid: this.#last.pid };
		return { state: "exited", generation: this.#last.generation, pid: this.#last.pid };
	}

	async close(): Promise<void> {
		this.#closed = true;
		await this.#starting?.catch(() => undefined);
		await this.#client.close();
		await this.#client.ended();
	}

	async #ensureLive(): Promise<void> {
		if (this.#closed) throw new Error("tool_child_unavailable: the session is closed");
		if (this.#client.state === "live") return;
		this.#starting ??= this.#client.start().finally(() => {
			this.#starting = undefined;
		});
		await this.#starting;
	}

	#onStatus(status: ToolChildStatus): void {
		if (status.state === "spawned") {
			const respawn = this.#last !== undefined;
			this.#last = { generation: status.generation, pid: status.pid };
			this.#options.onRecord({
				state: respawn ? "respawned" : "spawned",
				generation: status.generation,
				pid: status.pid,
			});
			return;
		}
		this.#options.onRecord({ state: "exited", generation: status.generation, pid: status.pid });
	}
}
