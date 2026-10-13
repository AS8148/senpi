import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

/**
 * Answer `detach_connection` only after every attachment the asking connection holds is gone (senpi#3238).
 * A plain socket close releases them too, but asynchronously, so another connection could still see the
 * attachment right after a short-lived client returned.
 */
export async function detachConnection(
	command: Extract<RpcCommand, { type: "detach_connection" }>,
	connectionId: string | undefined,
	release: (connectionId: string) => Promise<void>,
): Promise<RpcResponse> {
	if (connectionId === undefined) {
		return {
			id: command.id,
			type: "response",
			command: "detach_connection",
			success: false,
			error: "detach_connection needs a socket connection",
		};
	}
	await release(connectionId);
	return { id: command.id, type: "response", command: "detach_connection", success: true };
}
