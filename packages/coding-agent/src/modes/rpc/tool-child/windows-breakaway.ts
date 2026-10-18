/**
 * Starting a command outside the tool child's Job Object (senpi#3566, plan todo 4): the only way an explicit
 * `detached: true` launch on Windows can outlive the child. `CreateProcessW` with `CREATE_BREAKAWAY_FROM_JOB`
 * (allowed because the job sets `JOB_OBJECT_LIMIT_BREAKAWAY_OK`); the command inherits the caller's standard handles.
 * Struct layouts are the x64 ones (`STARTUPINFOW` 104 bytes, `PROCESS_INFORMATION` 24 bytes).
 */
import { windowsCommandLine } from "./windows-command-line.ts";

const CREATE_BREAKAWAY_FROM_JOB = 0x0100_0000;
const STARTF_USESTDHANDLES = 0x0000_0100;
const STARTUPINFOW_BYTES = 104;
const STARTUPINFO_FLAGS_OFFSET = 60;
const STARTUPINFO_STD_INPUT_OFFSET = 80;
const PROCESS_INFORMATION_BYTES = 24;
const PROCESS_ID_OFFSET = 16;
const INFINITE = 0xffff_ffff;
const STD_HANDLES = [-10, -11, -12] as const;

export interface Kernel32Process {
	CreateProcessW(commandLine: Uint8Array, flags: number, startupInfo: Uint8Array, processInfo: Uint8Array): number;
	GetStdHandle(which: number): bigint;
	WaitForSingleObject(handle: bigint, ms: number): number;
	GetExitCodeProcess(handle: bigint, exitCode: Uint8Array): number;
	CloseHandle(handle: bigint): number;
	GetLastError(): number;
}

export class BreakawayError extends Error {
	readonly code = "tool_child_breakaway_failed";
	constructor(step: string, win32Error: number) {
		super(`tool_child_breakaway_failed: ${step} failed (win32 error ${win32Error})`);
		this.name = "BreakawayError";
	}
}

function utf16z(text: string): Uint8Array {
	const units = new Uint16Array(text.length + 1);
	for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index);
	return new Uint8Array(units.buffer);
}

export interface BreakawayProcess {
	readonly pid: number;
	/** Blocks until the command exits and returns its exit code. */
	wait(): number;
}

export function startBreakaway(kernel: Kernel32Process, argv: readonly string[]): BreakawayProcess {
	const startupInfo = new Uint8Array(STARTUPINFOW_BYTES);
	const view = new DataView(startupInfo.buffer);
	view.setUint32(0, STARTUPINFOW_BYTES, true);
	view.setUint32(STARTUPINFO_FLAGS_OFFSET, STARTF_USESTDHANDLES, true);
	for (const [index, which] of STD_HANDLES.entries())
		view.setBigUint64(STARTUPINFO_STD_INPUT_OFFSET + index * 8, kernel.GetStdHandle(which), true);
	const processInfo = new Uint8Array(PROCESS_INFORMATION_BYTES);
	if (
		kernel.CreateProcessW(utf16z(windowsCommandLine(argv)), CREATE_BREAKAWAY_FROM_JOB, startupInfo, processInfo) === 0
	)
		throw new BreakawayError("CreateProcessW", kernel.GetLastError());
	const info = new DataView(processInfo.buffer);
	const process = info.getBigUint64(0, true);
	kernel.CloseHandle(info.getBigUint64(8, true));
	return {
		pid: info.getUint32(PROCESS_ID_OFFSET, true),
		wait: () => {
			kernel.WaitForSingleObject(process, INFINITE);
			const code = new Uint8Array(4);
			const ok = kernel.GetExitCodeProcess(process, code) !== 0;
			kernel.CloseHandle(process);
			if (!ok) throw new BreakawayError("GetExitCodeProcess", kernel.GetLastError());
			return new DataView(code.buffer).getUint32(0, true);
		},
	};
}

interface BunFfi {
	dlopen(
		library: string,
		symbols: Record<string, { args: readonly string[]; returns: string }>,
	): { symbols: Record<string, (...args: unknown[]) => unknown> };
	ptr(value: Uint8Array): unknown;
}

export function loadKernel32Process(): Kernel32Process | undefined {
	if (process.platform !== "win32") return undefined;
	const ffi = process.getBuiltinModule("bun:ffi") as BunFfi | undefined;
	if (ffi === undefined) return undefined;
	const lib = ffi.dlopen("kernel32.dll", {
		CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
		GetStdHandle: { args: ["i32"], returns: "u64" },
		WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
		GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
		CloseHandle: { args: ["u64"], returns: "i32" },
		GetLastError: { args: [], returns: "u32" },
	});
	const call = (name: string, ...args: unknown[]): unknown => {
		const fn = lib.symbols[name];
		if (fn === undefined) throw new Error(`kernel32 has no ${name}`);
		return fn(...args.map((arg) => (arg instanceof Uint8Array ? ffi.ptr(arg) : arg)));
	};
	return {
		CreateProcessW: (commandLine, flags, startupInfo, processInfo) =>
			Number(call("CreateProcessW", null, commandLine, null, null, 1, flags, null, null, startupInfo, processInfo)),
		GetStdHandle: (which) => BigInt(call("GetStdHandle", which) as number | bigint),
		WaitForSingleObject: (handle, ms) => Number(call("WaitForSingleObject", handle, ms)),
		GetExitCodeProcess: (handle, exitCode) => Number(call("GetExitCodeProcess", handle, exitCode)),
		CloseHandle: (handle) => Number(call("CloseHandle", handle)),
		GetLastError: () => Number(call("GetLastError")),
	};
}
