// Windows module-job body for the kill-before-heartbeat test (senpi#3566 todo 4): starts a long command that waits on a
// named event and returns its pid at once, leaving the command running inside the tool child's job.
import { spawn } from "node:child_process";

export function startGated(input: { readonly params: { readonly marker: string; readonly gate: string } }) {
	const command = spawn(
		"cmd.exe",
		["/d", "/c", `echo.> "${input.params.marker}" && waitfor ${input.params.gate} /t 300`],
		{
			stdio: "ignore",
		},
	);
	return { content: [{ type: "text", text: String(command.pid) }], details: { pid: command.pid } };
}

export function sleepFor(input: { readonly params: { readonly ms: number } }) {
	return new Promise((resolveSleep) =>
		setTimeout(
			() => resolveSleep({ content: [{ type: "text", text: "slept" }], details: { pid: process.pid } }),
			input.params.ms,
		),
	);
}
