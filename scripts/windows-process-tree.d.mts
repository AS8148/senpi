import type { spawnSync } from "node:child_process";

export function windowsTreeKillArgs(rootPid: number, run?: typeof spawnSync, selfPid?: number): string[];
