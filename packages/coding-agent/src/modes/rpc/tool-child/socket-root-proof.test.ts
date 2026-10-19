// senpi#3694: nothing is removed through a socket root before it is proven ours, the secret never outlives a failed
// claim, and a fallback root another user takes during the claim never blocks the start.
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openChannelListener } from "./channel.ts";
import { fallbackSocketRoot } from "./socket-root.ts";

interface Probe {
	hooks: Array<(secretPath: string) => Promise<void>>;
	order: string[];
}
const probe = vi.hoisted((): Probe => ({ hooks: [], order: [] }));
vi.mock("../socket-transport.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../socket-transport.ts")>();
	return {
		...original,
		createSocketSecret: async (path: string) => {
			await probe.hooks.shift()?.(path);
			const secret = await original.createSocketSecret(path);
			probe.order.push("secret");
			return secret;
		},
	};
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...original,
		rm: async (...args: Parameters<typeof original.rm>) => {
			if (String(args[0]).endsWith(".sock")) probe.order.push("rm-socket");
			return original.rm(...args);
		},
	};
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	probe.hooks = [];
	probe.order = [];
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratch(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function deepDir(): Promise<string> {
	const base = await scratch("tcproof-");
	return join(base, "c".repeat(60), "d".repeat(60), "tool-children", "0123456789abcdef0123456789abcdef0123");
}

describe.skipIf(process.platform === "win32")("tool-child socket root proof", () => {
	it("removes a stale socket only after the secret is written and the root proven", async () => {
		const dir = await scratch("tcproof-primary-");
		const listener = await openChannelListener({ dir, generation: 1 });
		await listener.close();
		expect(probe.order.slice(0, 2)).toEqual(["secret", "rm-socket"]);
	});

	it("leaves no secret behind when the retry's root is taken too, and refuses the start", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const foreign = await scratch("tcproof-foreign-");
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const swapTo = async (secretPath: string) => {
			const taken = dirname(secretPath);
			await rmdir(taken);
			await symlink(foreign, taken);
			cleanups.push(() => rm(taken, { force: true }));
		};
		probe.hooks = [swapTo, swapTo];
		await expect(openChannelListener({ dir, generation: 1 })).rejects.toThrow("socket_dir_unsafe");
		expect(await readdir(foreign)).toEqual([]);
	});

	it("starts under a fresh private directory when the secret write into a taken root is denied", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const denied = await scratch("tcproof-denied-");
		await chmod(denied, 0o500);
		cleanups.push(() => chmod(denied, 0o700));
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		probe.hooks = [
			async () => {
				await rmdir(root);
				await symlink(denied, root);
			},
		];
		const listener = await openChannelListener({ dir, generation: 1 });
		const socketRoot = dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL);
		cleanups.push(() => rm(socketRoot, { recursive: true, force: true }));
		expect(socketRoot.startsWith(`${root}-`)).toBe(true);
		expect(existsSync(listener.env.SENPI_TOOL_CHILD_CHANNEL_SECRET)).toBe(true);
		await listener.close();
	});

	it("never removes a file through a root swapped in before the proof", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const victim = await scratch("tcproof-victim-");
		await writeFile(join(victim, "c-1.sock"), "not ours");
		await mkdir(join(victim, "keep"), { recursive: true });
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		probe.hooks = [
			async () => {
				await rmdir(root);
				await symlink(victim, root);
			},
		];
		const listener = await openChannelListener({ dir, generation: 1 });
		cleanups.push(() => rm(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL), { recursive: true, force: true }));
		expect((await readdir(victim)).sort()).toEqual(["c-1.sock", "keep"]);
		await listener.close();
	});
});
