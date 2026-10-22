import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A realpath can hang (a stalled network mount). `gates` holds one open for a chosen path until the test releases it.
const hooks = vi.hoisted(() => ({ gates: new Map<string, Promise<void>>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const realpath = (async (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
		await hooks.gates.get(String(path));
		return Reflect.apply(actual.realpath, actual, [path, ...rest]);
	}) as typeof actual.realpath;
	return { ...actual, default: { ...actual, realpath }, realpath };
});

const { orderedRealPath } = await import("../../src/core/session-move/session-lock.ts");

const roots: string[] = [];
afterEach(() => {
	hooks.gates.clear();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sessionFiles(): { readonly a: string; readonly b: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-move-key-order-"));
	roots.push(root);
	const a = join(root, "a.jsonl");
	const b = join(root, "b.jsonl");
	writeFileSync(a, "");
	writeFileSync(b, "");
	return { a, b };
}

function hold(path: string): () => void {
	let release = (): void => {};
	hooks.gates.set(
		path,
		new Promise<void>((resolve) => {
			release = resolve;
		}),
	);
	return release;
}

describe("move lock keys resolve in call order per file, independently across files", () => {
	it("resolves another file's key while one file's realpath hangs", async () => {
		// Given file a whose realpath hangs
		const { a, b } = sessionFiles();
		const release = hold(a);
		let aSettled = false;
		const pendingA = orderedRealPath(a).then((path) => {
			aSettled = true;
			return path;
		});
		// When file b's key is resolved
		const resolvedB = await orderedRealPath(b);
		// Then b resolves without waiting for a, and a resolves once its realpath returns
		expect(resolvedB).toBe(realpathSync(b));
		expect(aSettled).toBe(false);
		release();
		expect(await pendingA).toBe(realpathSync(a));
	});

	it("keeps call order for one file even when the first resolution is slow", async () => {
		// Given two resolutions of the same file, the first held open
		const { a } = sessionFiles();
		const release = hold(a);
		const order: number[] = [];
		const first = orderedRealPath(a).then(() => order.push(1));
		const second = orderedRealPath(a).then(() => order.push(2));
		// When the first is released
		release();
		await Promise.all([first, second]);
		// Then they settled in call order
		expect(order).toEqual([1, 2]);
	});
});
