import { readFileSync } from "node:fs";
import { join } from "node:path";

export * from "../../qa-shared/lib/env.mjs";

export function readGeneratedToken(agentDir) {
	return readFileSync(join(agentDir, "app-server", "ws-token"), "utf8").trim();
}

export function makeThreadStartParams(cwd, approvalPolicy = "never") {
	return {
		cwd,
		model: "mock/mock-model",
		modelProvider: "mock",
		approvalPolicy,
	};
}

export function makeTextInput(text) {
	return [{ type: "text", text }];
}
