const notImplemented = (): never => {
	throw new Error("not implemented (senpi#3566 todo 5)");
};
export const QA_TOOL_PLACEMENTS: Readonly<Record<string, "child" | "server">> = {};
export function createQaTools(): { readonly name: string }[] {
	return notImplemented();
}
export function blobText(_bytes: number): string {
	return notImplemented();
}
export function sinkDigest(_payload: string): string {
	return notImplemented();
}
export async function runHostcalls(
	_params: { tool: string; args: unknown; count: number },
	_execute: (tool: string, args: unknown) => Promise<{ isError: boolean; text: string }>,
): Promise<unknown[]> {
	return notImplemented();
}
export function raiseSegv(_deps: {
	kill: (pid: number, signal: NodeJS.Signals) => unknown;
	exit: (code: number) => unknown;
	platform: NodeJS.Platform;
}): void {
	notImplemented();
}
export async function mutateFile(
	_params: { path: string; line: string },
	_options: { suspend: boolean; controlDir: string },
): Promise<void> {
	notImplemented();
}
