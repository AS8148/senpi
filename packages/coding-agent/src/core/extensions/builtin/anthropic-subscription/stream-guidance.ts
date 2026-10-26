import { AllAccountsBlockedError } from "./affinity.ts";
import { errorAccountContext } from "./account-context.ts";
import { classifySdkError } from "./errors.ts";
import type { ClaudeCodeRun } from "./executable.ts";
import { ClassifiedSdkError } from "./failover.ts";
import {
	allAccountsBlockedGuidance,
	claudeCodeVersionFloorGuidance,
	sdkErrorGuidance,
	singleAccountUnavailableGuidance,
} from "./guidance.ts";

export function withAuthGuidance(error: unknown, message: string, ran?: ClaudeCodeRun): string {
	if (error instanceof AllAccountsBlockedError)
		return error.unavailableAccount === undefined
			? allAccountsBlockedGuidance(error.soonestUnblockAt, error.blockReason)
			: singleAccountUnavailableGuidance(error.unavailableAccount, error.soonestUnblockAt, error.blockReason);
	const kind = classifySdkError(error).kind;
	const account = errorAccountContext(error instanceof ClassifiedSdkError ? error.original : error);
	if (account && (kind === "billing" || /\bout of extra usage\b/i.test(message))) {
		const selected = `Claude account '${account.accountLabel}' (source: ${account.accountSource}).`;
		const action =
			account.accountSource === "ambient"
				? "Switch the Claude login, choose a managed account with /claude-account pin <name>, or top up at claude.ai/settings/usage."
				: "Pin or switch accounts with /claude-account pin <name>, or top up this account at claude.ai/settings/usage.";
		return `${message}\n${selected} ${action}`;
	}
	const guidance = sdkErrorGuidance(kind);
	const versionGuidance = claudeCodeVersionFloorGuidance(message, ran);
	const hints = [guidance, versionGuidance].filter((hint): hint is string => hint !== undefined);
	return hints.length > 0 ? `${message}\n${hints.join("\n")}` : message;
}
