// senpi#3622 review: closing (or replacing) a session closes its in-process `ctx.offload` jobs. The module is cancelled,
// every further host call it makes is refused `host_call_session_closed`, and the lock it holds is released only once
// its write settles - after which the next session can take it. Replacement awaits the same `whenToolChildClosed()`.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { acquireFileMutationLock } from "../src/core/tools/file-mutation-queue.ts";
import { createHarness } from "./suite/harness.ts";

const EXTENSION = `export default function (pi) {
	pi.registerChildModule({ id: "hold", module: "./mod.ts", export: "hold" });
}
`;

const MODULE = `import { appendFileSync } from "node:fs";
export async function hold(args, host) {
	return host.withFileLock(args.file, async () => {
		const probe = globalThis.__offloadCloseProbe;
		probe.held();
		await probe.gate;
		try {
			await host.listTools();
			probe.answered("answered");
		} catch (error) {
			probe.answered(error.code ?? String(error));
		}
		appendFileSync(args.file, "late\\n");
		return "written";
	});
}
`;

interface Probe {
	held: () => void;
	gate: Promise<void>;
	answered: (code: string) => void;
}

describe.skipIf(process.platform === "win32")("closing a session under the in-process runtime", () => {
	it("refuses its offload job's host calls and releases its lock only after the write settles", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "offload-close-")));
		const extensionDir = join(dir, "ext");
		mkdirSync(extensionDir);
		writeFileSync(join(extensionDir, "index.ts"), EXTENSION);
		writeFileSync(join(extensionDir, "mod.ts"), MODULE);
		const file = join(dir, "target.txt");
		writeFileSync(file, "");
		let held: () => void = () => {};
		const heldNow = new Promise<void>((resolveHeld) => {
			held = resolveHeld;
		});
		let openGate: () => void = () => {};
		const gate = new Promise<void>((resolveGate) => {
			openGate = resolveGate;
		});
		let answered: (code: string) => void = () => {};
		const answer = new Promise<string>((resolveAnswer) => {
			answered = resolveAnswer;
		});
		const probe: Probe = { held, gate, answered };
		Reflect.set(globalThis, "__offloadCloseProbe", probe);
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: join(dir, "agent"),
			settingsManager: SettingsManager.inMemory({}),
			additionalExtensionPaths: [join(extensionDir, "index.ts")],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const harness = await createHarness({ resourceLoader: loader, cwd: dir, toolRuntime: "in-process" });
		try {
			await harness.session.bindExtensions({});
			const ctx = harness.session.extensionRunner.createContext();
			if (ctx.offload === undefined) throw new Error("runner context without offload");
			const job = ctx.offload("hold", { file });
			job.catch(() => {});
			await heldNow;

			harness.session.dispose();
			const closed = harness.session.whenToolChildClosed();
			let next = false;
			const nextLock = acquireFileMutationLock(file).then((release) => {
				next = true;
				return release;
			});
			// Every release the close could trigger is promise-driven: two full event-loop turns let it land if it would.
			for (let turn = 0; turn < 2; turn++) await new Promise((resolveTurn) => setImmediate(resolveTurn));
			expect(next).toBe(false);

			openGate();
			expect(await answer).toBe("host_call_session_closed");
			await closed;
			const release = await nextLock;
			release();
			expect(readFileSync(file, "utf8")).toBe("late\n");
		} finally {
			openGate();
			Reflect.deleteProperty(globalThis, "__offloadCloseProbe");
			harness.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
