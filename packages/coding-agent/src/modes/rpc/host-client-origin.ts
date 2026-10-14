/**
 * Which host a client runs INSIDE, so a host can tell its own sessions' connections from outside ones.
 *
 * A host's sessions reach other sessions on the same endpoint through its public socket: an omo
 * task tree keys its `p` shard by the root session, so a child running in that shard opens its own
 * children on the very shard it lives in. Counted as occupancy, those connections keep the shard
 * alive for as long as the shard is alive - after the owner and every outside client are gone, it
 * holds itself open forever (senpi#3272). A client therefore names the host generation it runs in
 * (`HOST_INSTANCE_ID_ENV`, which every host exports to the sessions it runs), and a host classifies
 * a connection from its own generation as DEPENDENT: it neither holds the host nor blocks its exit.
 * Hosts that predate the field ignore it (commands are parsed by `type`).
 */
import { HOST_INSTANCE_ID_ENV } from "./host-identity-env.ts";

export const ORIGIN_HOST_INSTANCE_FIELD = "origin_host_instance";

/** The host generation this process runs in, or undefined outside any host. */
export function originHostInstance(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
	const instance = env[HOST_INSTANCE_ID_ENV]?.trim();
	return instance ? instance : undefined;
}

/** The generation a request line says its client runs in; undefined when unmarked or not JSON. */
export function requestOriginHostInstance(line: string): string | undefined {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof request !== "object" || request === null || Array.isArray(request)) return undefined;
	const origin: unknown = Reflect.get(request, ORIGIN_HOST_INSTANCE_FIELD);
	return typeof origin === "string" && origin.length > 0 ? origin : undefined;
}
