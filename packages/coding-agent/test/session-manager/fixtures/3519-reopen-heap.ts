import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../../src/core/session-manager.ts";

// Run under Bun by 3519-reopen-heap.test.ts: a session whose history before its latest compaction
// is 40 MB of ordinary small turns, reopened; prints the live heap the reopened manager holds.
const TURNS = 20_000;
const dir = mkdtempSync(join(tmpdir(), "reopen-heap-"));
try {
	const seed = SessionManager.create(dir, dir);
	seed.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
	const file = seed.getSessionFile()!;
	const [header, seedLine] = readFileSync(file, "utf8").trim().split("\n");
	const seedEntry = JSON.parse(seedLine!);
	const lines = [header!];
	let parentId: string | null = null;
	for (let turn = 0; turn < TURNS; turn++) {
		const id = turn.toString(16).padStart(8, "0");
		const text = `turn ${turn} ${"a".repeat(2000)}`;
		lines.push(JSON.stringify({ ...seedEntry, id, parentId, message: { ...seedEntry.message, content: text } }));
		parentId = id;
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
	const writer = SessionManager.open(file, dir);
	const firstKept = writer.appendMessage({ role: "user", content: "kept", timestamp: Date.now() });
	writer.appendCompaction("summary", firstKept, 1000);
	writer.appendMessage({ role: "user", content: "after", timestamp: Date.now() });

	const bun: unknown = Reflect.get(globalThis, "Bun");
	const gc: unknown = typeof bun === "object" && bun !== null ? Reflect.get(bun, "gc") : undefined;
	if (typeof gc !== "function") throw new Error("run this fixture under Bun");
	const heapMb = () => {
		Reflect.apply(gc, bun, [true]);
		return process.memoryUsage().heapUsed / 1048576;
	};
	const baseline = heapMb();
	const reopened = SessionManager.open(file, dir);
	// What an idle session keeps: its owner drops the materialized views when it settles.
	reopened.dropMaterializedCaches();
	const retainedMb = heapMb() - baseline;
	const contextMessages = reopened.buildSessionContext().messages.length;
	console.log(JSON.stringify({ retainedMb, contextMessages, entries: reopened.getEntryCount() }));
} finally {
	rmSync(dir, { recursive: true, force: true });
}
