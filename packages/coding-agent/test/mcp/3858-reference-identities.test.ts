import { createHmac } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mcpCredentialIdentity } from "../../src/core/extensions/builtin/mcp/auth/catalog-identity.ts";
import { hashConfig, normalizeServer } from "../../src/core/extensions/builtin/mcp/config.ts";
import { referenceRoot } from "../suite/regressions/3858-reference-support.ts";

describe("keyed configuration identities (#3858)", () => {
	let files: ReturnType<typeof referenceRoot>;
	beforeEach(() => {
		files = referenceRoot();
	});
	afterEach(() => files.close());

	it("publishes a complete private installation key and reuses it", () => {
		const config = normalizeServer({ command: "fixture", args: ["synthetic-secret"] });
		const first = Reflect.apply(hashConfig, undefined, [config, files.root]);
		const path = join(files.root, "config-identity.key");
		expect(readFileSync(path)).toHaveLength(32);
		if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(Reflect.apply(hashConfig, undefined, [config, files.root])).toBe(first);
		expect(Reflect.apply(hashConfig, undefined, [{ ...config, args: ["rotated"] }, files.root])).not.toBe(first);
	});

	it("uses HMAC rather than an offline-guessable bearer fingerprint", () => {
		const config = normalizeServer({ type: "http", url: "https://example.invalid", bearerTokenEnv: "TOKEN" });
		const identity = mcpCredentialIdentity(config, "fixture", files.root, { TOKEN: "1234" });
		const key = readFileSync(join(files.root, "config-identity.key"));
		const expected = createHmac("sha256", key)
			.update(JSON.stringify(["mcp-catalog-bearer", "1234"]))
			.digest("hex");
		expect(identity).toBe(expected);
	});

	it.each(["partial", "permissions", "oversize"])("never replaces or trusts an invalid %s key", (kind) => {
		const path = files.file(
			"config-identity.key",
			kind === "partial" ? "short" : "k".repeat(kind === "oversize" ? 33 : 32),
		);
		if (kind === "permissions") chmodSync(path, 0o644);
		const before = readFileSync(path);
		const config = normalizeServer({ command: "fixture" });
		const identity = Reflect.apply(hashConfig, undefined, [config, files.root]);
		expect(identity).toMatch(/^ephemeral:/);
		expect(readFileSync(path)).toEqual(before);
	});

	it("keeps a completed published key when an abandoned temporary file exists", () => {
		files.file("config-identity.key.abandoned.tmp", "");
		const key = Buffer.alloc(32, 7);
		writeFileSync(join(files.root, "config-identity.key"), key, { mode: 0o600 });
		const config = normalizeServer({ command: "fixture" });
		expect(Reflect.apply(hashConfig, undefined, [config, files.root])).not.toMatch(/^ephemeral:/);
		expect(readFileSync(join(files.root, "config-identity.key"))).toEqual(key);
	});
});
