import { loadMcpConfig, mergeExtensionMcpServers } from "./extensions/builtin/mcp/config.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";
import { promptSizeExtensionNames } from "./prompt-size-extension-names.ts";

export interface PromptSizeStartupNotes {
	readonly mcp?: {
		readonly count: number;
		readonly names: readonly string[];
		readonly note: string;
	};
	readonly thirdPartySessionStart: {
		readonly names: readonly string[];
		readonly note: string;
	};
}

/** Config inventory only: never materializes MCP transports or exposes their endpoints. */
export function promptSizeStartupNotes(input: {
	readonly cwd: string;
	readonly runner: ExtensionRunner;
	readonly sizesOnlyStartup: boolean;
}): PromptSizeStartupNotes {
	const names = promptSizeExtensionNames(input.runner.getExtensionPaths());
	const thirdPartySessionStart = {
		names: input.runner.getThirdPartySessionStartPaths().map((path) => names.get(path) ?? "extension"),
		note: "these third-party session_start hooks ran during startup and may have used the network",
	};
	if (!input.sizesOnlyStartup) return { thirdPartySessionStart };
	const context = input.runner.createContext();
	const config = loadMcpConfig({ cwd: input.cwd, projectTrusted: context.isProjectTrusted() });
	mergeExtensionMcpServers(config, context.getRegisteredMcpServers?.() ?? []);
	const servers = Object.keys(config.servers).sort();
	return {
		mcp: { count: servers.length, names: servers, note: "not attached; tool sizes exclude them" },
		thirdPartySessionStart,
	};
}
