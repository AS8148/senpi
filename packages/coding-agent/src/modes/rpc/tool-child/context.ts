export interface ChildToolContext {
	cwd: string;
}
export function narrowContext(_ctx: object, _ids: { sessionId?: string; toolCallId: string }): ChildToolContext {
	throw new Error("not implemented");
}
