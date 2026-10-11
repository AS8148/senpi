import { devNull } from "node:os";

/**
 * pip's environment with every PIP_* variable removed and its config file pointed at nothing: `--isolated`
 * alone still honours PIP_CONFIG_FILE, and a configured target, root or prefix would install outside the revision.
 */
export function isolatedPipEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.toUpperCase().startsWith("PIP_")) env[key] = value;
	}
	// pip skips every config file when PIP_CONFIG_FILE equals Python's os.devnull: "nul" on Windows, not Node's "\\\\.\\nul".
	return { ...env, PIP_CONFIG_FILE: process.platform === "win32" ? "nul" : devNull, PYTHONNOUSERSITE: "1" };
}
