// Bun-runtime probe (senpi#3566 todo 4, review HIGH 1): the session's own extension loader - the default in-process
// path - gives an extension the REAL node:child_process. Prints one JSON line with what it observed.
import realChildProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadExtensions } from "../../src/core/extensions/loader.ts";

const dir = join(tmpdir(), `lcp-${process.pid}`);
mkdirSync(dir, { recursive: true });
const extension = join(dir, "probe-ext.ts");
writeFileSync(
	extension,
	`import cp, { exec } from "node:child_process";
import { createRequire } from "node:module";
export default function () {
	const req = createRequire(import.meta.url);
	globalThis.__lcpProbe = { defaultImport: cp, namedExec: exec, required: req("node:child_process"), requiredBare: req("child_process") };
}
`,
);
const result = await loadExtensions([extension], dir);
const probe = Reflect.get(globalThis, "__lcpProbe") as Record<string, unknown> | undefined;
const namedExec = probe?.namedExec;
const promised = typeof namedExec === "function" ? await promisify(namedExec)("echo hi") : undefined;
console.log(
	JSON.stringify({
		loadErrors: result.errors.map((error) => String(error.error)),
		defaultIsReal: probe?.defaultImport === realChildProcess,
		namedExecIsReal: namedExec === realChildProcess.exec,
		requiredIsReal: probe?.required === realChildProcess,
		requiredBareIsReal: probe?.requiredBare === realChildProcess,
		promised,
	}),
);
process.exit(0);
