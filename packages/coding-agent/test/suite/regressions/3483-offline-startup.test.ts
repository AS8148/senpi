import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as imageGenAuth from "../../../src/core/extensions/builtin/imagegen/auth.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import openaiImageGen from "../../../src/core/extensions/builtin/openai-image-gen/index.ts";
import { sharingHttpFixture } from "../../mcp/fixtures/sharing-http.ts";
import { createHarness } from "../harness.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("sizes-only startup network boundary (#3483)", () => {
	it("does not resolve client image credentials during diagnostic startup or preview", async () => {
		// Given: credential resolution can perform OAuth network work.
		const resolve = vi.spyOn(imageGenAuth, "resolveImageGenAuth");
		const harness = await createHarness({ extensionFactories: [openaiImageGen] });
		try {
			// When
			await harness.session.bindExtensions({ mode: "print", sizesOnly: true });
			const result = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.({
				sizesOnly: true,
			});
			// Then
			expect(result?.status).toBe("ready");
			expect(resolve).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});
	it.each([true, false])("skips connections only for sizesOnly=%s", async (sizesOnly) => {
		// Given: a real recording MCP server and the actual built-in extension.
		const server = await sharingHttpFixture();
		const service = new McpService();
		const harness = await createHarness({
			extensionFactories: [{ path: "<builtin:mcp>", factory: createMcpExtension(service) }],
		});
		const agentDir = join(harness.tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: { recording: { type: "http", url: server.url, lifecycle: "eager", startupTimeoutMs: 5000 } },
			}),
		);
		vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);
		try {
			// When: preview awaits the built-in attach promise, not a timing delay.
			await harness.session.bindExtensions({ mode: "print", sizesOnly });
			const result = await harness.getExtensionRunner().createContext().getPromptCachePrefixRequest?.({
				sizesOnly: true,
			});
			await service.whenAttachSettled(10_000);
			// Then
			if (result?.status !== "ready") throw new Error("Expected prefix");
			if (sizesOnly) {
				expect(server.connections).toBe(0);
				expect(result.request.sizeReport?.mcp).toEqual({
					count: 1,
					names: ["recording"],
					note: "not attached; tool sizes exclude them",
				});
			} else {
				expect(server.connects).toBeGreaterThan(0);
			}
		} finally {
			await service.dispose("quit");
			harness.cleanup();
			await server.close();
		}
	});
});
