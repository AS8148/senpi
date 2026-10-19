// senpi#3694: nothing is removed through a socket root before it is proven ours, nothing already at the secret's name is
// ever followed or overwritten, the secret never outlives a failed claim, and a fallback root another user takes during
// the claim never blocks the start.
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSocketRootWindow, socketRootWindow } from "../../../../test/helpers/socket-root-window.ts";
import { openChannelListener } from "./channel.ts";
import { fallbackSocketRoot } from "./socket-root.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const { withSocketRootWindow } = await import("../../../../test/helpers/socket-root-window.ts");
	return withSocketRootWindow(await importOriginal<typeof import("node:fs/promises")>());
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	resetSocketRootWindow();
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

function takeRootAs(target: string): (root: string) => Promise<void> {
	return async (root) => {
		await rmdir(root);
		await symlink(target, root);
		cleanups.push(() => rm(root, { force: true }));
	};
}

describe.skipIf(process.platform === "win32")("tool-child socket root proof", () => {
	it("removes a stale socket only after the secret is written and the root proven", async () => {
		const dir = await scratch("tcproof-primary-");
		const listener = await openChannelListener({ dir, generation: 1 });
		await listener.close();
		expect(socketRootWindow.order.slice(0, 2)).toEqual(["secret", "rm-socket"]);
	});

	it("never writes through an entry planted at the secret's name in a taken root", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		const victim = join(await scratch("tcproof-victim-"), "authorized_keys");
		await writeFile(victim, "keep me");
		await chmod(victim, 0o644);
		const taken = await scratch("tcproof-taken-");
		await symlink(victim, join(taken, "c-1.sock.secret"));
		socketRootWindow.windows = [takeRootAs(taken)];
		const listener = await openChannelListener({ dir, generation: 1 });
		cleanups.push(() => rm(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL), { recursive: true, force: true }));
		expect(await readFile(victim, "utf8")).toBe("keep me");
		expect((await lstat(victim)).mode & 0o777).toBe(0o644);
		expect(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL).startsWith(`${root}-`)).toBe(true);
		await listener.close();
	});

	it("leaves no secret behind when the retry's root is taken too, and refuses the start", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const foreign = await scratch("tcproof-foreign-");
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		socketRootWindow.windows = [takeRootAs(foreign), takeRootAs(foreign)];
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
		socketRootWindow.windows = [takeRootAs(denied)];
		const listener = await openChannelListener({ dir, generation: 1 });
		const socketRoot = dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL);
		cleanups.push(() => rm(socketRoot, { recursive: true, force: true }));
		expect(socketRoot.startsWith(`${root}-`)).toBe(true);
		expect(existsSync(listener.env.SENPI_TOOL_CHILD_CHANNEL_SECRET)).toBe(true);
		await listener.close();
	});

	it("never removes a file through a root that is swapped while it is still empty", async () => {
		const dir = await deepDir();
		const root = fallbackSocketRoot(dir);
		const victim = await scratch("tcproof-victim-");
		await writeFile(join(victim, "c-1.sock"), "not ours");
		cleanups.push(() => rm(root, { recursive: true, force: true }));
		let swapped = false;
		socketRootWindow.onSocketRemoval = async (socketPath) => {
			const socketRoot = dirname(socketPath);
			if (swapped || socketRoot !== root || (await readdir(socketRoot)).length > 0) return;
			swapped = true;
			await takeRootAs(victim)(socketRoot);
		};
		const listener = await openChannelListener({ dir, generation: 1 }).catch(() => undefined);
		if (listener !== undefined) {
			cleanups.push(() => rm(dirname(listener.env.SENPI_TOOL_CHILD_CHANNEL), { recursive: true, force: true }));
			await listener.close();
		}
		expect(await readdir(victim)).toEqual(["c-1.sock"]);
	});
});
