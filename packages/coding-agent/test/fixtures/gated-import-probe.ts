// Bun-runtime probe for the extension child_process redirect (senpi#3566 todo 4). argv[2] = "server" | "child".
import realCp from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunExtensionImporter } from "../../src/core/extensions/bun-extension-importer.ts";
import {
	CHILD_PROCESS_REDIRECTS,
	childProcessVirtualModule,
	GATED_CHILD_PROCESS_ID,
	installChildProcessModule,
} from "../../src/modes/rpc/tool-child/gated-modules.ts";

const role = process.argv[2];
const calls: string[] = [];
if (role === "child")
	installChildProcessModule({
		...realCp,
		spawnSync: (...args: Parameters<typeof realCp.spawnSync>) => {
			calls.push("gated");
			return realCp.spawnSync(...args);
		},
	});
const dir = join(tmpdir(), `gip-${process.pid}`);
mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
writeFileSync(
	join(dir, "node_modules", "dep", "package.json"),
	JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }),
);
writeFileSync(
	join(dir, "node_modules", "dep", "index.js"),
	'const cp = require("child_process"); module.exports = () => cp.spawnSync("true").status;',
);
writeFileSync(
	join(dir, "ext.ts"),
	'import { spawnSync } from "node:child_process";\nimport cpDefault from "child_process";\nimport viaDep from "dep";\nexport default () => [spawnSync("true").status, cpDefault.spawnSync("true").status, viaDep()];',
);
const importer = createBunExtensionImporter(
	{ [GATED_CHILD_PROCESS_ID]: childProcessVirtualModule() },
	CHILD_PROCESS_REDIRECTS,
);
const factory = (await importer.import(join(dir, "ext.ts"), { default: true })) as () => number[];
console.log(JSON.stringify({ statuses: factory(), calls }));
