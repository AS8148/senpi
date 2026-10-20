import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInstanceId } from "../../src/modes/rpc/protocol-identity.ts";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

export async function attachmentRig() {
	const dir = await mkdtemp(join(tmpdir(), "rpc-attachment-"));
	const rig = createInProcessRig(dir);
	return {
		...rig,
		dir,
		async session(holds = 1) {
			const data = opened(await rig.open("caller", {
				cwd: dir,
				sessionPath: join(dir, "session.jsonl"),
				retain_on_disconnect: true,
			}), 0);
			for (let index = 1; index < holds; index++)
				await rig.open("caller", { cwd: dir, sessionPath: data.state.sessionFile });
			if (holds === 0) await rig.drop("caller");
			return {
				sessionId: data.sessionId,
				durableSessionId: data.state.sessionId,
				sessionPath: data.state.sessionFile,
				expectedHostInstance: hostInstanceId(),
			};
		},
		async [Symbol.asyncDispose]() {
			rig.teardown.release();
			await rig[Symbol.asyncDispose]();
			await rm(dir, { recursive: true, force: true });
		},
	};
}
