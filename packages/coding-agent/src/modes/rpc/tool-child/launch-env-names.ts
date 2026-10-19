/** This generation's ledger path; the child reads it to sweep owned groups when its host disappears. */
export const TOOL_CHILD_LEDGER_ENV = "SENPI_TOOL_CHILD_LEDGER";

/**
 * Every variable the server sets only for the tool child itself. The child scrubs them from its own environment once it
 * has read them, so no command it starts inherits them (a nested senpi would otherwise enter the tool-child role).
 * `internal-env.test.ts` pins this list against the constants it names.
 */
export const TOOL_CHILD_INTERNAL_ENV = [
	"SENPI_INTERNAL_ROLE",
	"SENPI_TOOL_CHILD_CHANNEL",
	"SENPI_TOOL_CHILD_CHANNEL_SECRET",
	"SENPI_TOOL_CHILD_GENERATION",
	TOOL_CHILD_LEDGER_ENV,
	"SENPI_TOOL_CHILD_MODULE_ROOTS",
] as const;

export function scrubToolChildEnv(env: NodeJS.ProcessEnv): void {
	for (const name of TOOL_CHILD_INTERNAL_ENV) delete env[name];
}
