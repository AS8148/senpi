import { afterEach, describe, expect, it, vi } from "vitest";
import senpiCodemode, { type CodemodeExtensionAPI } from "../../../../senpi-codemode/src/index.ts";
import { FakeKernel, fakeExtensionContext } from "../../../../senpi-codemode/test/eval/fakes.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "../harness.ts";

interface Fixture {
	readonly harness: Harness;
	readonly kernel: FakeKernel;
	readonly notices: unknown[];
	readonly connection: RpcConnectionHandler;
	readonly chunks: string[];
	readonly tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0];
	readonly context: ReturnType<typeof fakeExtensionContext>;
}

describe("3072 session-scoped eval cell RPC", () => {
	const fixtures: Fixture[] = [];

	afterEach(async () => {
		for (const f of fixtures.splice(0)) {
			await f.harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "exit" });
			await f.connection.dispose();
			f.harness.cleanup();
		}
		vi.useRealTimers();
	});

	async function fixture(): Promise<Fixture> {
		const kernel = new FakeKernel([]);
		const notices: unknown[] = [];
		let tool: Parameters<CodemodeExtensionAPI["registerTool"]>[0] | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					senpiCodemode(
						{
							...pi,
							registerTool: (registered) => {
								tool = registered;
								pi.registerTool(registered);
							},
							sendMessage: (message, options) => notices.push({ message, options }),
						},
						{
							createSessionManager: () => ({
								getKernel: async (_language, onMessage) => {
									kernel.onMessage = onMessage;
									return kernel;
								},
								dispose: async () => kernel.close(),
								complete: async () => ({ text: "", details: { model: "fixture", structured: false } }),
							}),
						},
					),
			],
		});
		const chunks: string[] = [];
		// Same runtime-host seam as rpc-extension-requests.test.ts; replacement is not exercised.
		const host = {
			session: harness.session,
			setRebindSession: () => {},
			dispose: async () => {},
		} as AgentSessionRuntime;
		const connection = createRpcConnectionHandler(
			host,
			{ writeRaw: (chunk) => chunks.push(chunk), waitForBackpressure: async () => {} },
			{
				sessionId: harness.sessionManager.getSessionId(),
				capabilities: ["extension_events"],
				eventFlushScheduler: (flush) => flush(),
			},
		);
		await connection.ready;
		if (!tool) throw new Error("eval not registered");
		const registered = tool;
		const context = fakeExtensionContext();
		const f = { harness, kernel, notices, connection, chunks, tool: registered, context };
		fixtures.push(f);
		return f;
	}

	async function rpc(f: { connection: RpcConnectionHandler; chunks: string[] }, type: string, data = {}) {
		const id = crypto.randomUUID();
		await f.connection.handleInputLine(JSON.stringify({ id, type, ...data }));
		const records: Record<string, unknown>[] = f.chunks.flatMap((chunk) =>
			chunk
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		);
		const response = records.find((record) => record.id === id);
		if (!response) throw new Error(`No response for ${type}`);
		return response;
	}

	async function detach(f: Fixture, id = "cell") {
		const started = f.kernel.deferNextRun();
		const execution = f.tool.execute(
			id,
			{ language: "js", code: "await work", summary: "fixture cell", timeout: 300, on_timeout: "detach" },
			undefined,
			undefined,
			f.context,
		);
		await started;
		await vi.advanceTimersByTimeAsync(60_000);
		await execution;
	}

	function history(harness: Harness) {
		return {
			messages: structuredClone(harness.session.messages),
			entries: structuredClone(harness.sessionManager.getEntries()),
		};
	}

	it("round-trips list, bounded peek, and confirmed stop on the same detached manager", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		await detach(f);
		f.kernel.emit({ type: "text", stream: "stdout", data: "start αβ🙂 tail" });
		const listed = await rpc(f, "eval_cells.list");
		expect(listed).toMatchObject({
			success: true,
			data: [
				{
					cellId: "cell",
					language: "js",
					state: "detached",
					startedAtMs: expect.any(Number),
					summary: "fixture cell",
				},
			],
		});
		expect(await rpc(f, "eval_cells.peek", { cellId: "cell", tailBytes: 6 })).toMatchObject({
			success: true,
			data: { cellId: "cell", state: "detached", outputTail: " tail" },
		});
		expect(await rpc(f, "eval_cells.stop", { cellId: "cell" })).toMatchObject({
			success: true,
			data: { cellId: "cell", state: "cancelled", stateRetained: true },
		});
		expect(f.kernel.interrupts).toHaveLength(1);
		const events = f.chunks.flatMap((chunk) =>
			chunk
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line)),
		);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "extension_event",
					name: "wake_source_state",
					sessionId: f.harness.sessionManager.getSessionId(),
					data: expect.objectContaining({
						source: "senpi-codemode",
						activeCount: 1,
						items: [{ id: "cell", description: "fixture cell", startedAtMs: expect.any(Number) }],
					}),
				}),
				expect.objectContaining({
					type: "extension_event",
					name: "wake_source_state",
					data: { source: "senpi-codemode", activeCount: 0, items: [] },
				}),
			]),
		);
	});

	it("confirms stop and delivers exactly the unchanged model completion notification", async () => {
		vi.useFakeTimers();
		const rpcCell = await fixture();
		const toolCell = await fixture();
		await detach(rpcCell);
		await detach(toolCell);
		await toolCell.tool.execute(
			"control",
			{ action: "stop", cell_id: "cell" },
			undefined,
			undefined,
			toolCell.context,
		);
		expect(await rpc(rpcCell, "eval_cells.stop", { cellId: "cell" })).toMatchObject({
			success: true,
			data: { state: "cancelled", stateRetained: true },
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(rpcCell.notices).toHaveLength(1);
		expect(rpcCell.notices).toEqual(toolCell.notices);
	});

	it("adds zero model context or history entries for list, peek, and already-ended stop", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		await detach(f);
		f.kernel.completeDeferredRun({ type: "result", cellId: "cell", ok: true, durationMs: 0 });
		await vi.advanceTimersByTimeAsync(0);
		const before = history(f.harness);
		for (const type of ["eval_cells.list", "eval_cells.peek", "eval_cells.stop"]) {
			expect(await rpc(f, type, { cellId: "cell" })).toMatchObject({ success: true });
			expect(history(f.harness)).toEqual(before);
		}
		expect(f.harness.session.getAllTools().some((tool) => tool.name.startsWith("eval_cells."))).toBe(false);
	});

	it("refuses unknown and cross-session ids with a typed not-found response", async () => {
		vi.useFakeTimers();
		const owner = await fixture();
		const other = await fixture();
		await detach(owner, "private-cell");
		for (const type of ["eval_cells.peek", "eval_cells.stop"]) {
			expect(await rpc(other, type, { cellId: "private-cell" })).toMatchObject({
				success: false,
				errorCode: "eval_cell_not_found",
			});
			expect(await rpc(owner, type, { cellId: "unknown" })).toMatchObject({
				success: false,
				errorCode: "eval_cell_not_found",
			});
		}
		expect(owner.kernel.interrupts).toHaveLength(0);
	});

	it("returns the typed completed state when a listed cell ended before stop", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		await detach(f);
		expect(await rpc(f, "eval_cells.list")).toMatchObject({ success: true, data: [{ state: "detached" }] });
		f.kernel.completeDeferredRun({ type: "result", cellId: "cell", ok: true, durationMs: 12 });
		await vi.advanceTimersByTimeAsync(0);
		const noticeCount = f.notices.length;
		expect(await rpc(f, "eval_cells.stop", { cellId: "cell" })).toMatchObject({
			success: true,
			data: { cellId: "cell", state: "completed" },
		});
		expect(f.kernel.interrupts).toHaveLength(0);
		expect(f.notices).toHaveLength(noticeCount);
	});

	it("rejects malformed identifiers and tail budgets with a typed invalid request", async () => {
		const f = await fixture();
		for (const data of [
			{},
			{ cellId: "" },
			{ cellId: 42 },
			{ cellId: "cell", tailBytes: -1 },
			{ cellId: "cell", tailBytes: 1.5 },
		]) {
			expect(await rpc(f, "eval_cells.peek", data)).toMatchObject({
				success: false,
				errorCode: "invalid_eval_cell_request",
			});
		}
	});

	it("bounds default, oversized, and zero-byte tails without splitting UTF-8", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		await detach(f);
		f.kernel.emit({ type: "text", stream: "stdout", data: "α".repeat(40_000) });
		for (const [tailBytes, limit] of [
			[undefined, 8 * 1024],
			[Number.MAX_SAFE_INTEGER, 64 * 1024],
			[0, 0],
		] as const) {
			const response = await rpc(f, "eval_cells.peek", {
				cellId: "cell",
				...(tailBytes === undefined ? {} : { tailBytes }),
			});
			expect(response.success).toBe(true);
			const data = response.data;
			if (
				typeof data !== "object" ||
				data === null ||
				!("outputTail" in data) ||
				typeof data.outputTail !== "string"
			) {
				throw new Error("Missing output tail");
			}
			expect(Buffer.byteLength(data.outputTail)).toBeLessThanOrEqual(limit);
			expect(data.outputTail).not.toContain("\ufffd");
		}
	});

	it("confirms a terminal state when stopping a listed foreground cell", async () => {
		vi.useFakeTimers();
		const f = await fixture();
		const started = f.kernel.deferNextRun();
		const execution = f.tool.execute(
			"foreground",
			{ language: "js", code: "await work", summary: "foreground cell" },
			undefined,
			undefined,
			f.context,
		);
		await started;
		expect(await rpc(f, "eval_cells.list")).toMatchObject({ success: true, data: [{ state: "running" }] });
		expect(await rpc(f, "eval_cells.stop", { cellId: "foreground" })).toMatchObject({
			success: true,
			data: { state: "cancelled", stateRetained: true },
		});
		await execution;
		expect(f.notices).toHaveLength(0);
	});
});
