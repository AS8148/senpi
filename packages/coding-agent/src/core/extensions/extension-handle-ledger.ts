import { realpathSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type HandleOwner,
	handleOwnerStore,
	installHandleTracking,
	type OwnedHandleKind,
} from "./extension-handle-tracking.ts";
import type { Extension } from "./types.ts";

/**
 * Per extension instance: the handles its code created and has not released yet.
 * `reclaim()` runs once, after the instance's `session_shutdown` handlers, and closes
 * whatever is still open (senpi#2292). A closed ledger records nothing new.
 */
class ExtensionHandleLedger implements HandleOwner {
	private readonly open = new Set<{ readonly kind: OwnedHandleKind; readonly release: () => void }>();
	private closed = false;

	private readonly ownsPath: (creatorPath: string) => boolean;

	constructor(ownsPath: (creatorPath: string) => boolean) {
		this.ownsPath = ownsPath;
	}

	ownsCreatorFrame(creatorPath: string): boolean {
		return !this.closed && this.ownsPath(creatorPath);
	}

	track(kind: OwnedHandleKind, release: () => void): () => void {
		const handle = { kind, release };
		this.open.add(handle);
		return () => {
			this.open.delete(handle);
		};
	}

	reclaim(): { readonly counts: Readonly<Record<OwnedHandleKind, number>>; readonly failures: readonly string[] } {
		this.closed = true;
		const counts: Record<OwnedHandleKind, number> = { server: 0, socket: 0, timer: 0 };
		const failures: string[] = [];
		for (const handle of this.open) {
			try {
				handle.release();
				counts[handle.kind]++;
			} catch (error) {
				failures.push(`${handle.kind}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		this.open.clear();
		return { counts, failures };
	}
}

/** `src/` (or `dist/`) of this package: code there is senpi's own, never an extension's. */
function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Both spellings of a directory: Bun's stack frames name real paths, Node's name the path a module was
 * imported by, so a directory reached through a symlink (macOS `/tmp`, a symlinked checkout) can appear as either.
 */
function directorySpellings(directory: string): readonly string[] {
	try {
		const real = realpathSync(directory);
		return real === directory ? [directory] : [directory, real];
	} catch {
		return [directory];
	}
}

const isInsideAny = (child: string, parents: readonly string[]) => parents.some((parent) => isInside(child, parent));

const SENPI_CODE_ROOTS = (() => {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return directorySpellings(here.endsWith(path.join("core", "extensions")) ? path.resolve(here, "..", "..") : here);
})();

/**
 * The owner test for one extension. A file extension owns what code under its own
 * directory creates (its dependencies included when they live there). An inline
 * factory has no directory, so it owns what any code outside senpi's own creates.
 */
function ownershipTest(extension: Extension): (creatorPath: string) => boolean {
	if (extension.sourceInfo.baseDir === undefined) return (creatorPath) => !isInsideAny(creatorPath, SENPI_CODE_ROOTS);
	const directories = directorySpellings(path.dirname(extension.resolvedPath));
	return (creatorPath) => isInsideAny(creatorPath, directories);
}

const ledgers = new WeakMap<Extension, ExtensionHandleLedger>();

/** Builtin extensions are senpi's own code and manage their handles themselves. */
function ledgerFor(extension: Extension): ExtensionHandleLedger | undefined {
	if (extension.sourceInfo.source === "builtin") return undefined;
	let ledger = ledgers.get(extension);
	if (ledger === undefined) {
		ledger = new ExtensionHandleLedger(ownershipTest(extension));
		ledgers.set(extension, ledger);
	}
	return ledger;
}

/** Runs `task` as `extension`'s code: servers, sockets and timers it creates are recorded for it. */
export function runOwnedBy<T>(extension: Extension, task: () => T): T {
	const ledger = ledgerFor(extension);
	if (ledger === undefined) return task();
	installHandleTracking();
	return handleOwnerStore.run(ledger, task);
}

/** `fn`, entered as `extension`'s code on every call; builtins get `fn` itself back. */
export function ownedBy<This, Args extends unknown[], Result>(
	extension: Extension,
	fn: (this: This, ...args: Args) => Result,
): (this: This, ...args: Args) => Result {
	if (extension.sourceInfo.source === "builtin") return fn;
	return function (this: This, ...args: Args): Result {
		return runOwnedBy(extension, () => fn.apply(this, args));
	};
}

const runnerExtensions = new WeakMap<object, readonly Extension[]>();

/** Called by `ExtensionRunner`'s constructor: the instances `reclaimRunnerHandles` closes for that runner. */
export function registerRunnerExtensions(runner: object, extensions: readonly Extension[]): void {
	runnerExtensions.set(runner, extensions);
}

/** `reclaimExtensionHandles` for the extension instances of `runner`; a runner never registered has none. */
export function reclaimRunnerHandles(runner: object): void {
	reclaimExtensionHandles(runnerExtensions.get(runner) ?? []);
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Closes what each extension instance left open after its `session_shutdown`
 * handlers ran, and reports it per extension on stderr so the extension can be fixed.
 */
export function reclaimExtensionHandles(extensions: readonly Extension[]): void {
	for (const extension of extensions) {
		const ledger = ledgers.get(extension);
		if (ledger === undefined) continue;
		const { counts, failures } = ledger.reclaim();
		const total = counts.server + counts.socket + counts.timer;
		if (total === 0 && failures.length === 0) continue;
		const closed = [
			plural(counts.server, "server"),
			plural(counts.socket, "socket"),
			plural(counts.timer, "timer"),
		].join(", ");
		const failed = failures.length > 0 ? `; could not close ${failures.join("; ")}` : "";
		console.warn(
			`Extension ${extension.path} left handles open after session_shutdown; senpi closed ${closed}${failed}. Stop session-scoped resources in a session_shutdown handler (docs/extensions.md#session_shutdown).`,
		);
	}
}
