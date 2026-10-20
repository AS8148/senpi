// #3796: storage and observer contracts shared by native and legacy engines.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	addGrant, declarationDigest, type GrantObservation, list, observe, read, resolveGrantsStorePath, revoke,
} from "../../../src/core/extensions/builtin/mcp/env-grants-store.ts";

let root: string;
let stop: (() => void) | undefined;
const label = { project: "/synthetic/project", skill: "carrier", server: "probe" };
const identity = declarationDigest({ command: "synthetic-probe" });

beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), "senpi-3796-store-")); });
afterEach(() => {
	stop?.();
	stop = undefined;
	vi.restoreAllMocks();
	vi.useRealTimers();
	fs.rmSync(root, { recursive: true, force: true });
});

function observationStream() {
	const events: GrantObservation[] = [];
	const waiters = new Set<{ predicate: (event: GrantObservation) => boolean; resolve: (event: GrantObservation) => void }>();
	return {
		events,
		listener(event: GrantObservation) {
			events.push(event);
			for (const waiter of waiters) if (waiter.predicate(event)) {
				waiters.delete(waiter);
				waiter.resolve(event);
			}
		},
		next(predicate: (event: GrantObservation) => boolean): Promise<GrantObservation> {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					waiters.delete(waiter);
					reject(new Error("Expected grant observation did not arrive"));
				}, 10_000);
				const waiter = { predicate, resolve: (event: GrantObservation) => { clearTimeout(timer); resolve(event); } };
				waiters.add(waiter);
			});
		},
	};
}

it("resolves under the caller's configured engine directory", () => {
	expect(resolveGrantsStorePath(root)).toBe(join(root, "mcp-env-grants.json"));
});

it("merges concurrent atomic writers and revokes only the selected identity", async () => {
	const path = resolveGrantsStorePath(root);
	const second = declarationDigest({ command: "synthetic-second" });
	await Promise.all([
		addGrant(path, identity, label, ["ODD_DSN"]),
		addGrant(path, second, label, ["ODD_COOKIE"]),
	]);
	const snapshot = await read(path);
	expect(snapshot.generation).toBe(2);
	expect(snapshot.grants[identity]?.names).toEqual(["ODD_DSN"]);
	expect(snapshot.grants[second]?.names).toEqual(["ODD_COOKIE"]);
	await revoke(path, identity);
	expect((await read(path)).generation).toBe(3);
	expect((await list(path)).map((grant) => grant.digest)).toEqual([second]);
	const disk: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
	expect(disk).toEqual({ version: 1, generation: 3, grants: { [second]: { label, names: ["ODD_COOKIE"] } } });
	expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"]);
});

it("keeps valid non-identifier environment names and rejects names with = or NUL", async () => {
	const path = resolveGrantsStorePath(root);
	await addGrant(path, identity, label, ["ProgramFiles(x86)", "odd-name"]);
	expect((await read(path)).grants[identity]?.names).toEqual(["ProgramFiles(x86)", "odd-name"]);
	await expect(addGrant(path, identity, label, ["A=B"])).rejects.toThrow();
	await expect(addGrant(path, identity, label, ["A\0B"])).rejects.toThrow();
	expect((await read(path)).generation).toBe(1);
});

it("fails closed and leaves no grant or temporary lock after a failed rename", async () => {
	const path = resolveGrantsStorePath(root);
	fs.mkdirSync(path);
	await expect(addGrant(path, identity, label, ["ODD_DSN"])).rejects.toThrow();
	expect((await read(path)).grants).toEqual({});
	expect(fs.readdirSync(root)).toEqual(["mcp-env-grants.json"]);
});

it("watches creation and atomic replacements from before the store exists", async () => {
	const path = resolveGrantsStorePath(join(root, "not-created-yet"));
	const stream = observationStream();
	stop = await observe(path, stream.listener);
	const created = stream.next((event) => event.snapshot.generation === 1);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	expect((await created).snapshot.grants[identity]?.names).toEqual(["ODD_DSN"]);
	const revoked = stream.next((event) => event.snapshot.generation === 2);
	await revoke(path, identity);
	expect((await revoked).snapshot.grants[identity]).toBeUndefined();
	const latest = stream.next((event) => event.snapshot.generation >= 4);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	await revoke(path, identity);
	expect((await latest).snapshot.grants[identity]).toBeUndefined();
});

it("polls latest state and conservatively invalidates skipped revoke/regrant and recreation", async () => {
	const realWatch = fs.watch;
	// Real watcher, deliberately no change listener: model a filesystem that
	// loses watch notifications. The production five-second fallback must work.
	vi.spyOn(fs, "watch").mockImplementation((filename) => realWatch(filename, { persistent: false }));
	vi.useFakeTimers();
	const path = resolveGrantsStorePath(root);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	const stream = observationStream();
	stop = await observe(path, stream.listener);
	await revoke(path, identity);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	const skipped = stream.next((event) => event.snapshot.generation === 3);
	await vi.advanceTimersByTimeAsync(5_000);
	expect((await skipped).conservative).toBe(true);
	fs.rmSync(path);
	await addGrant(path, identity, label, ["ODD_DSN"]);
	const recreated = stream.next((event) => event.snapshot.generation === 1);
	await vi.advanceTimersByTimeAsync(5_000);
	expect((await recreated).conservative).toBe(true);
	expect(stream.events.at(-1)?.snapshot.grants[identity]?.names).toEqual(["ODD_DSN"]);
});
