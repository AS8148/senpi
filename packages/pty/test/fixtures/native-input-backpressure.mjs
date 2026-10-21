import { setTimeout as delay } from "node:timers/promises";
import { nativePty } from "../../native/index.js";

if (nativePty.native === null) {
	throw new Error("native PTY fixture requires a host prebuild");
}

let writeReturned = false;
let chunksAfterWrite = 0;
const session = nativePty.native.startPtySession(
	{
		command: "sh",
		args: ["-c", "while :; do printf '%s\\n' 0123456789012345678901234567890123456789; done"],
		cols: 80,
		rows: 24,
	},
	() => {
		if (writeReturned) chunksAfterWrite += 1;
	},
);

session.write(`${"x".repeat(63)}\n`.repeat(16_384));
writeReturned = true;

const deadline = Date.now() + 5_000;
while (chunksAfterWrite < 20 && Date.now() < deadline) await delay(10);
session.kill("SIGKILL");
await session.waitExit();

process.stdout.write(`${JSON.stringify({ writeReturned, outputFlowedAfterWrite: chunksAfterWrite >= 20 })}\n`);
