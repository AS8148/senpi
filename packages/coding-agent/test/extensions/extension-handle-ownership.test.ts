import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reclaimExtensionHandles, runOwnedBy } from "../../src/core/extensions/extension-handle-ledger.ts";
import type { Extension } from "../../src/core/extensions/types.ts";
import { createSyntheticSourceInfo } from "../../src/core/source-info.ts";

interface FixtureModule {
	open(): { server: Server; interval: ReturnType<typeof setInterval>; listening: Promise<void> };
}

function fakeExtension(resolvedPath: string, source: string, baseDir: string | undefined): Extension {
	return {
		path: resolvedPath,
		resolvedPath,
		sourceInfo: createSyntheticSourceInfo(resolvedPath, { source, baseDir }),
		handlers: new Map(),
		tools: new Map(),
		removedToolHints: new Map(),
		lazyToolActivators: [],
		filesystemPolicies: [],
		messageRenderers: new Map(),
		memoryReporters: new Map(),
		entryRenderers: undefined,
		commands: new Map(),
		rpcHandlers: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		mcpServers: new Map(),
		registrationCwd: baseDir ?? process.cwd(),
	};
}

const activeTimeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

describe("extension handle ownership (senpi#2292)", () => {
	let directory: string;
	let fixture: FixtureModule;
	let warn: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "handle-ownership-"));
		const file = join(directory, "fixture.mjs");
		writeFileSync(
			file,
			[
				'import net from "node:net";',
				"export function open() {",
				"\tconst interval = setInterval(() => {}, 60_000);",
				"\tconst server = net.createServer();",
				'\tconst listening = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
				"\treturn { server, interval, listening };",
				"}",
			].join("\n"),
		);
		// The fixture must be a real file under the extension's directory: ownership is decided by the creating frame's path.
		fixture = await import(pathToFileURL(file).href);
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		warn.mockRestore();
		rmSync(directory, { recursive: true, force: true });
	});

	it("closes what the extension's own code left open and reports it per extension", async () => {
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const before = activeTimeouts();
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;
		expect(activeTimeouts()).toBe(before + 1);

		reclaimExtensionHandles([extension]);

		expect(opened.server.listening).toBe(false);
		expect(activeTimeouts()).toBe(before);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(`Extension ${extension.path} left handles open`);
		expect(String(warn.mock.calls[0]?.[0])).toContain("senpi closed 1 server, 0 sockets, 1 timer");
	});

	it("leaves handles alone that code outside the extension created on its behalf", () => {
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const interval = runOwnedBy(extension, () => setInterval(() => {}, 60_000));
		const before = activeTimeouts();

		reclaimExtensionHandles([extension]);

		expect(activeTimeouts()).toBe(before);
		expect(warn).not.toHaveBeenCalled();
		clearInterval(interval);
	});

	it("reports nothing when the extension released its handles itself", async () => {
		const extension = fakeExtension(join(directory, "index.ts"), "local", directory);
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;
		clearInterval(opened.interval);
		await new Promise<void>((resolve) => opened.server.close(() => resolve()));

		reclaimExtensionHandles([extension]);

		expect(warn).not.toHaveBeenCalled();
	});

	it("never tracks builtin extensions", async () => {
		const extension = fakeExtension("builtin:fixture", "builtin", directory);
		const opened = runOwnedBy(extension, () => fixture.open());
		await opened.listening;

		reclaimExtensionHandles([extension]);

		expect(opened.server.listening).toBe(true);
		expect(warn).not.toHaveBeenCalled();
		clearInterval(opened.interval);
		await new Promise<void>((resolve) => opened.server.close(() => resolve()));
	});
});
