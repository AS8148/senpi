/**
 * What `/share` uploads by default (#3524): the conversation (user and assistant
 * text, tool names and tool-call arguments), never what tools returned. Tool
 * results, `!` command output, extension messages and extension state are
 * replaced by a one-line note unless the user explicitly includes tool outputs
 * in the preview. Redaction still runs over everything that is shared.
 */

export interface OutputOmissions {
	count: number;
}

const OMITTED_RESULT_HTML = ["resultHtmlCollapsed", "resultHtmlExpanded"] as const;

function note(label: string): { type: "text"; text: string } {
	return { type: "text", text: `[output omitted: ${label}]` };
}

function projectRecord(
	record: Record<string, unknown>,
	omissions: OutputOmissions,
): Record<string, unknown> | undefined {
	if (record.role === "toolResult") {
		omissions.count++;
		const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
		return { ...record, content: [note(toolName)], details: undefined };
	}
	if (record.role === "bashExecution") {
		if (String(record.output ?? "").startsWith("[output omitted: ")) return record;
		omissions.count++;
		return { ...record, output: "[output omitted: command]", fullOutputPath: undefined };
	}
	if (record.role === "custom" || record.type === "custom_message") {
		omissions.count++;
		const customType = typeof record.customType === "string" ? record.customType : "extension";
		return { ...record, content: [note(customType)], details: undefined };
	}
	if (record.type === "custom") return { ...record, data: undefined };
	return undefined;
}

function projectRenderedTools(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([id, rendered]) => {
			if (rendered === null || typeof rendered !== "object") return [id, rendered];
			const kept = Object.entries(rendered).filter(
				([key]) => !OMITTED_RESULT_HTML.some((omitted) => omitted === key),
			);
			return [id, Object.fromEntries(kept)];
		}),
	);
}

/** Replace every tool output reachable from `value` with a note; idempotent, so it may run on entries and again on the whole payload. */
export function omitToolOutputs<T>(value: T, omissions: OutputOmissions): T {
	return project(value, omissions) as T;
}

function project(value: unknown, omissions: OutputOmissions): unknown {
	if (Array.isArray(value)) return value.map((item) => project(item, omissions));
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (isOmissionNote(record)) return record;
	const projected = projectRecord(record, omissions);
	if (projected) return projected;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(record)) {
		out[key] = key === "renderedTools" ? projectRenderedTools(child) : project(child, omissions);
	}
	return out;
}

function isOmissionNote(record: Record<string, unknown>): boolean {
	const content = record.content;
	return (
		Array.isArray(content) &&
		content.length === 1 &&
		typeof content[0] === "object" &&
		content[0] !== null &&
		String(Reflect.get(content[0], "text") ?? "").startsWith("[output omitted: ")
	);
}
