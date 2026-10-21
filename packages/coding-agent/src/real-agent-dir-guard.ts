import { userInfo } from "node:os";
import { join, resolve, sep } from "node:path";

/** Config directories of the shipped brands; the active brand's own directory is added at call time. */
const KNOWN_BRAND_CONFIG_DIRS = [".senpi", ".omo", ".pi"] as const;

/** A test run resolved the real user's agent directory, where its writes would land in live state (#3867). */
export class RealAgentDirInTestError extends Error {
	override readonly name = "RealAgentDirInTestError";
	readonly agentDir: string;

	constructor(agentDir: string) {
		super(
			`Refusing to use the real agent directory ${agentDir} from a test run. ` +
				"Point <BRAND>_CODING_AGENT_DIR at a temp dir, or set SENPI_TEST_USE_REAL_AGENT_DIR=1 to opt in.",
		);
		this.agentDir = agentDir;
	}
}

function isTestRun(env: NodeJS.ProcessEnv): boolean {
	return env.VITEST !== undefined || env.NODE_ENV === "test";
}

function realHomeDir(): string | undefined {
	try {
		return userInfo().homedir;
	} catch {
		return undefined;
	}
}

/**
 * Throws `RealAgentDirInTestError` when a test run (Vitest or `bun test`) resolves an agent
 * directory inside the real user's brand config directory. The real home comes from the account
 * database, not `$HOME`, so a test that redirects `$HOME` to a temp dir still resolves freely.
 */
export function assertAgentDirAllowedInTests(
	agentDir: string,
	activeConfigDirName: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!isTestRun(env) || env.SENPI_TEST_USE_REAL_AGENT_DIR === "1") return;
	const home = realHomeDir();
	if (!home) return;
	const target = resolve(agentDir);
	for (const configDir of new Set([...KNOWN_BRAND_CONFIG_DIRS, activeConfigDirName])) {
		const root = join(home, configDir);
		if (target === root || target.startsWith(root + sep)) throw new RealAgentDirInTestError(target);
	}
}
