import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readMcpCatalogCache, writeMcpCachedServer } from "../../src/core/extensions/builtin/mcp/catalog-cache.ts";
import { diagnoseCapturedMcpConnectFailure } from "../../src/core/extensions/builtin/mcp/diagnose.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { ensureMcpResourceSubscriptions } from "../../src/core/extensions/builtin/mcp/resources.ts";
import { buildMcpServerSnapshot } from "../../src/core/extensions/builtin/mcp/service-snapshot.ts";
import { ROTATED, referenceRoot, resolveReference, SECRET } from "../suite/regressions/3858-reference-support.ts";
import { serverConfig } from "./fixtures/reconnect.ts";

// #3858: redaction is an outbound projection, never a mutation of protocol data.
describe("reference disclosure boundaries", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		files = referenceRoot();
	});
	afterEach(() => files.close());

	async function resolve(value = SECRET) {
		await resolveReference({ $env: "VALUE" }, { root: files.root, env: { VALUE: value } });
	}

	it("redacts raw, URL encoded and nested cause values from logs after rotation", async () => {
		await resolve();
		await resolve(ROTATED);
		const logger = createMcpLogger("fixture", { logDir: files.root });
		logger.info(`${SECRET} ${encodeURIComponent(SECRET)}`, new Error(ROTATED, { cause: new Error(SECRET) }));
		const output = logger.getRingBuffer().join("\n") + readFileSync(logger.filePath, "utf8");
		for (const value of [SECRET, ROTATED, encodeURIComponent(SECRET)]) expect(output).not.toContain(value);
		expect(output).toContain("redacted");
	});

	it("retains all 257 active values and an old value after later rotations", async () => {
		const values = Array.from({ length: 258 }, (_, index) => `synthetic-3858-entry-${index}-end`);
		for (const value of values) await resolve(value);
		const logger = createMcpLogger("retired", { logDir: files.root });
		logger.info(values.join(" "));
		const output = logger.getRingBuffer().join("\n");
		for (const value of values) expect(output).not.toContain(value);
	});

	it("keeps subscription identifiers raw while persisting a separate redacted catalog", async () => {
		await resolve();
		const uri = `fixture://${SECRET}`;
		const resources = [{ name: "resource", uri }];
		const subscribed: string[] = [];
		await Reflect.apply(ensureMcpResourceSubscriptions, undefined, [
			{
				getServerCapabilities: () => ({ resources: { subscribe: true } }),
				subscribeResource: async ({ uri: target }: { uri: string }) => {
					subscribed.push(target);
					return {};
				},
			},
			resources,
		]);
		await writeMcpCachedServer(files.root, "fixture", {
			configHash: "synthetic-hmac",
			credentialIdentity: "none",
			fetchedAt: Date.now(),
			tools: [],
			prompts: [],
			resources,
		});
		expect(subscribed).toEqual([uri]);
		expect(resources[0]?.uri).toBe(uri);
		expect(JSON.stringify(await readMcpCatalogCache(files.root))).not.toContain(SECRET);
	});

	it("sanitizes snapshot and diagnostic errors without changing the original error", async () => {
		await resolve();
		const error = new Error(`reflected ${SECRET}`, { cause: new Error(encodeURIComponent(SECRET)) });
		const snapshot = Reflect.apply(buildMcpServerSnapshot, undefined, [
			"fixture",
			undefined,
			{ state: "degraded", generation: 1, getRootPid: () => null, lastError: error },
			undefined,
		]);
		expect(JSON.stringify(snapshot)).not.toContain(SECRET);
		const logger = createMcpLogger("diagnostic", { logDir: files.root });
		logger.stderr(SECRET);
		const diagnostic = diagnoseCapturedMcpConnectFailure({
			config: serverConfig(),
			cause: error,
			logger,
			serverName: "fixture",
		});
		expect(diagnostic?.message).not.toContain(SECRET);
		expect(error.message).toContain(SECRET);
	});
});
