export type SpawnApi = "bun.spawn" | "bun.spawnSync" | "bun.shell" | "cp.spawn" | "cp.spawnSync" | "cp.execFileSync";
export interface SpawnFixtureResult {
	readonly pid?: number;
	readonly pgid?: number;
	readonly jobId?: string;
	readonly containment: "own-group" | "inherited" | "none";
	readonly lifetime: "owned" | "detached";
	readonly markerSeen: boolean;
	readonly exitCode?: number;
}
export async function spawnFixture(
	_params: { api: SpawnApi; argv: string[]; detached?: boolean; viaShell?: boolean; gate?: boolean },
	_options: { controlDir: string; launchId: string },
): Promise<SpawnFixtureResult> {
	throw new Error("not implemented (senpi#3566 todo 5)");
}
