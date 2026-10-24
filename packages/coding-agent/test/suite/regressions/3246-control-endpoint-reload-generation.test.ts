/**
 * senpi#3246: a control endpoint belongs to the extension generation that registered it. A reload
 * retires that generation, so its endpoint must go with it: a wake never runs the retired
 * generation's `drain` (which surfaced as "control endpoint drain failed: stale extension
 * generation after reload" on every wake).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionFactory } from "../../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { controlRequest } from "../../helpers/session-control-client.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

const cleanups: Array<() => unknown> = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Terminal {
	readonly harness: Harness;
	readonly mode: InteractiveMode;
	readonly notices: string[];
}

async function terminal(options: HarnessOptions, beforeBind: (harness: Harness) => void = () => {}): Promise<Terminal> {
	const harness = await createHarness({ persistSession: true, ...options });
	cleanups.push(() => harness.cleanup());
	const notices: string[] = [];
	const runtime = Object.assign(Object.create(AgentSessionRuntime.prototype), { _session: harness.session });
	const mode = new InteractiveMode(runtime);
	const ui = new TUI(new VirtualTerminal(120, 40));
	Reflect.set(mode, "ui", ui);
	Reflect.set(mode, "showWarning", (line: string) => notices.push(line));
	cleanups.push(() => ui.stop());
	beforeBind(harness);
	const bind = Reflect.get(mode, "bindCurrentSessionExtensions");
	if (typeof bind !== "function") throw new TypeError("InteractiveMode lost its extension bind path");
	await bind.call(mode);
	return { harness, mode, notices };
}

/** A resource loader whose `reload()` loads the factory again: each reload is a real new extension generation. */
async function generationalLoader(factory: ExtensionFactory): Promise<HarnessOptions["resourceLoader"]> {
	let current = await createTestExtensionsResult([factory]);
	return {
		...createTestResourceLoader({ extensionsResult: current }),
		getExtensions: () => current,
		reload: async () => {
			current = await createTestExtensionsResult([factory]);
		},
	};
}

function wakeReply(socket: string): Promise<string> {
	return Promise.resolve()
		.then(() => controlRequest(socket, { type: "wake" }))
		.then(
			(answer) => answer.kind,
			(error: unknown) => (error instanceof Error && "code" in error ? String(error.code) : "rejected"),
		);
}

const drainFailures = (notices: readonly string[]) => notices.filter((line) => line.includes("drain failed"));

describe.skipIf(process.platform === "win32")("senpi#3246 a control endpoint after a reload", () => {
	it("#given an endpoint registered once at startup #when the session reloads #then the retired generation's endpoint is gone and its drain never runs again", async () => {
		const sockets: string[] = [];
		const drains: number[] = [];
		let generations = 0;
		let inboxRoot = "";
		const { harness } = await terminal(
			{
				extensionFactories: [
					(pi) => {
						generations += 1;
						const generation = generations;
						pi.on("session_start", async (event) => {
							if (event.reason !== "startup") return;
							const registration = await pi.session.registerControlEndpoint({
								inboxDir: join(inboxRoot, "inbox"),
								drain: () => {
									drains.push(generation);
									return undefined;
								},
							});
							if (registration.status !== "registered") throw new Error(JSON.stringify(registration));
							cleanups.push(() => registration.dispose());
							sockets.push(registration.socket);
						});
					},
				],
			},
			(harness) => {
				inboxRoot = harness.tempDir;
			},
		);
		expect(sockets).toHaveLength(1);
		await harness.session.reload();
		const before = drains.length;

		expect(["closed", "ENOENT", "ECONNREFUSED"]).toContain(await wakeReply(sockets[0]));
		expect(drains.slice(before)).toEqual([]);
	});

	it("#given a registration still in flight across a reload #when the new generation registers and a wake arrives #then only the new drain runs, the host tracks it, and no notice is shown", async () => {
		// Shaped like the production registrant: every session_start registers without being awaited, and
		// session_shutdown disposes what has registered so far, so an in-flight registration outlives it.
		let generations = 0;
		const drains: number[] = [];
		const results = new Map<number, Promise<{ status: string; socket?: string }>>();
		const factory: ExtensionFactory = (pi) => {
			generations += 1;
			const generation = generations;
			let settled: { status: string; dispose?: () => Promise<void> } | undefined;
			pi.on("session_start", () => {
				const pending = pi.session.registerControlEndpoint({
					inboxDir: join(inboxRoot, "inbox"),
					drain: () => {
						drains.push(generation);
						// What the production drain does first: read the admission gate through its own `pi.session`.
						pi.session.admissionGate();
						return undefined;
					},
				});
				results.set(
					generation,
					pending.then((registration) => {
						settled = registration;
						if (registration.status === "registered") cleanups.push(() => registration.dispose());
						return registration;
					}),
				);
			});
			pi.on("session_shutdown", async () => {
				await settled?.dispose?.();
			});
		};
		let inboxRoot = "";
		let openGate: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const { harness, mode, notices } = await terminal(
			{ resourceLoader: await generationalLoader(factory) },
			(harness) => {
				inboxRoot = harness.tempDir;
				// The startup registration stalls inside the host (its header write), past the reload.
				const manager = harness.session.sessionManager;
				const persist = manager.persistHeaderNow.bind(manager);
				let first = true;
				manager.persistHeaderNow = async () => {
					if (first) {
						first = false;
						await gate;
					}
					await persist();
				};
			},
		);
		await harness.session.reload();
		openGate();
		const retired = await results.get(1);
		const current = await results.get(2);
		if (current?.status !== "registered" || current.socket === undefined) throw new Error(JSON.stringify(current));
		const retiredWake = retired?.socket === undefined ? "none" : await wakeReply(retired.socket);
		const currentWake = await wakeReply(current.socket);
		const sessionFile = harness.session.sessionManager.getSessionFile();
		const host = Reflect.get(mode, "sessionControlHost");
		const tracked: unknown = Reflect.get(Reflect.get(host, "active") ?? {}, "socket");

		expect({
			retired: retired?.status,
			retiredWake,
			currentWake,
			drains: [...new Set(drains)],
			notices: drainFailures(notices),
			tracked: tracked === current.socket,
			sessionFileKept: sessionFile !== undefined && existsSync(sessionFile),
		}).toEqual({
			retired: "failed",
			retiredWake: "none",
			currentWake: "answered",
			drains: [2],
			notices: [],
			tracked: true,
			sessionFileKept: true,
		});
	});

	it("#given a drain that keeps failing #when wakes repeat #then one notice shows until a pass succeeds again", async () => {
		let failing = true;
		let socket = "";
		let inboxRoot = "";
		const { notices } = await terminal(
			{
				extensionFactories: [
					(pi) => {
						pi.on("session_start", async () => {
							const registration = await pi.session.registerControlEndpoint({
								inboxDir: join(inboxRoot, "inbox"),
								drain: () => {
									if (failing) throw new Error("inbox store unreadable");
									return undefined;
								},
							});
							if (registration.status !== "registered") throw new Error(JSON.stringify(registration));
							cleanups.push(() => registration.dispose());
							socket = registration.socket;
						});
					},
				],
			},
			(harness) => {
				inboxRoot = harness.tempDir;
			},
		);
		for (let wake = 0; wake < 3; wake += 1) await wakeReply(socket);
		const whileFailing = drainFailures(notices).length;
		failing = false;
		await wakeReply(socket);
		failing = true;
		await wakeReply(socket);

		expect({ whileFailing, afterRecovery: drainFailures(notices).length }).toEqual({
			whileFailing: 1,
			afterRecovery: 2,
		});
	});
});
