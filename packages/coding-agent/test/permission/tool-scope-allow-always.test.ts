/**
 * senpi#3403 (sisyphuslabs/omo-desktop-app#2465): "Allow always" on a tool without its own parser
 * remembered only the exact argument, so a browser or MCP tool asked again for the next URL or
 * input. A wider option covers that: per DOMAIN for a URL argument (never tool-wide: that would mean
 * "go anywhere"), tool-wide for a free `input` argument, and nothing wider for a command or path.
 */
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "../../src/core/extensions/builtin/permission-system/evaluate.ts";
import { widerAlwaysScope } from "../../src/core/extensions/builtin/permission-system/always-scope.ts";
import { closeLiveHosts, createLiveHost, type LivePermissionHost } from "./live-permission-host.ts";

afterEach(closeLiveHosts);

/** Runs one call, answers its prompt with `answer` (by exact label), returns the options shown. */
async function callAnswering(host: LivePermissionHost, tool: string, input: Record<string, unknown>, answer: string) {
	const run = host.runProbe(tool, input);
	const prompt = await host.waitForPrompt();
	expect(prompt.options).toContain(answer);
	prompt.resolve(answer);
	await run;
	return prompt.options;
}

describe("a wider Allow always for tools without a parser (#3403)", () => {
	it("a URL tool offers this DOMAIN: same domain stops asking, another domain asks again", async () => {
		// given an ask-preset session and a URL-shaped tool with no parser
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		// when the first URL is answered with the domain scope
		const options = await callAnswering(
			host,
			"fetch_fixture",
			{ url: "https://example.invalid/a" },
			"Allow fetch_fixture on example.invalid always in this project",
		);
		expect(options).not.toContain("Allow fetch_fixture always in this project");

		// then another URL on that domain runs without a prompt
		await host.runProbe("fetch_fixture", { url: "https://example.invalid/b?q=1" });
		expect(host.prompts()).toBe(1);
		expect(host.toolResultIsError("fetch_fixture")).toBe(false);

		// and a look-alike or a different domain still asks
		const lookAlike = host.runProbe("fetch_fixture", { url: "https://example.invalid.evil.test/" });
		(await host.waitForPrompt()).resolve("Deny");
		await lookAlike;
		expect(host.prompts()).toBe(2);
	}, 30_000);

	it("a second open session in the same project stops asking for that domain too", async () => {
		const first = await createLiveHost({ preset: "ask" });
		await first.bind();
		const second = await createLiveHost({ preset: "ask", shareHostWith: first });
		await second.bind();

		await callAnswering(
			first,
			"fetch_fixture",
			{ url: "https://example.invalid/a" },
			"Allow fetch_fixture on example.invalid always in this project",
		);

		await second.runProbe("fetch_fixture", { url: "https://example.invalid/other" });
		expect(second.prompts()).toBe(0);
		expect(second.toolResultIsError("fetch_fixture")).toBe(false);
	}, 30_000);

	it("a tool with a free input argument offers the tool for this project", async () => {
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		await callAnswering(host, "query_fixture", { input: "first" }, "Allow query_fixture always in this project");

		await host.runProbe("query_fixture", { input: "something else" });
		expect(host.prompts()).toBe(1);
	}, 30_000);

	it("a command-shaped tool never offers a wider scope", async () => {
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();

		const run = host.runProbe("shell_fixture", { command: "echo one" });
		const prompt = await host.waitForPrompt();
		expect(prompt.options.filter((option) => option.endsWith("always in this project"))).toEqual([]);
		prompt.resolve("Deny");
		await run;
	}, 30_000);
});

describe("widerAlwaysScope (#3403)", () => {
	const domain = widerAlwaysScope("fetch_fixture", "url", "https://example.invalid/a");

	it("covers the URL's own origin, and nothing that only starts like it", () => {
		const rules = (domain?.patterns ?? []).map((pattern) => ({ permission: "fetch_fixture", pattern, action: "allow" as const }));
		const allowed = (url: string) => evaluate("fetch_fixture", url, rules).action === "allow";
		expect(allowed("https://example.invalid")).toBe(true);
		expect(allowed("https://example.invalid/deep/path")).toBe(true);
		expect(allowed("https://example.invalid/?x=1")).toBe(true);
		// "?" is a one-character wildcard in patterns, so no query pattern is offered: a bare query asks
		expect(allowed("https://example.invalid?x=1")).toBe(false);
		expect(allowed("https://example.invalid.evil.test/")).toBe(false);
		expect(allowed("https://example.invalid@evil.test/")).toBe(false);
		expect(allowed("https://example.invalid:8443/")).toBe(false);
		expect(allowed("http://example.invalid/")).toBe(false);
	});

	it("offers nothing for a command, a path, a non-http URL or an arg-less call", () => {
		expect(widerAlwaysScope("shell_fixture", "command", "echo hi")).toBeUndefined();
		expect(widerAlwaysScope("tool", "path", "/etc/passwd")).toBeUndefined();
		expect(widerAlwaysScope("tool", "url", "file:///etc/passwd")).toBeUndefined();
		expect(widerAlwaysScope("bash", "input", "x")).toBeUndefined();
	});
});
