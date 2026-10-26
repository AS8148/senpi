import { describe, expect, it } from "vitest";
import { analyzeBashCommand } from "../../src/core/extensions/builtin/permission-system/bash-command-segments.ts";
import { fromConfig, rulesForPreset } from "../../src/core/extensions/builtin/permission-system/config.ts";
import {
	createBuiltinParserRegistry,
	UNPARSED_BASH_PREFIX,
} from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { PermissionService } from "../../src/core/extensions/builtin/permission-system/service.ts";
import type {
	PermissionConfig,
	PermissionPresetName,
	Rule,
} from "../../src/core/extensions/builtin/permission-system/types.ts";

const cwd = "/workspace/project";
const registry = createBuiltinParserRegistry();

type Outcome = "allow" | "ask" | "deny";

async function decide(
	preset: PermissionPresetName,
	command: string,
	{ config = {}, approved = [] }: { config?: PermissionConfig; approved?: Rule[] } = {},
): Promise<Outcome> {
	const service = new PermissionService(
		[...rulesForPreset(preset), ...fromConfig(config)],
		approved,
		undefined,
		preset,
	);
	for (const request of registry.parse("bash", { command }, cwd)) {
		const answer = service
			.ask(
				{
					sessionID: "s",
					permission: request.permission,
					patterns: request.patterns,
					always: request.always,
					metadata: {},
				},
				{ autoApproveAsk: request.autoApproveAsk ?? false },
			)
			.then(
				() => "allow" as const,
				() => "deny" as const,
			);
		const pending = service.list();
		if (pending.length > 0) {
			for (const entry of pending) service.reply({ requestID: entry.id, reply: "reject" });
			await answer;
			return "ask";
		}
		if ((await answer) === "deny") return "deny";
	}
	return "allow";
}

const always = (...prefixes: string[]): Rule[] =>
	prefixes.flatMap((prefix) => [
		{ permission: "bash", pattern: prefix, action: "allow" as const },
		{ permission: "bash", pattern: `${prefix} *`, action: "allow" as const },
	]);

const TARGET = "rm -rf build";

/** Shapes that run TARGET after (or inside) a command the user already allowed. */
const CHAINED_SHAPES: ReadonlyArray<readonly [string, string]> = [
	["and-list", `cd src && ${TARGET}`],
	["or-list", `cd src || ${TARGET}`],
	["sequence", `cd src; ${TARGET}`],
	["sequence without space", `cd src;${TARGET}`],
	["pipeline", `cd src | ${TARGET}`],
	["pipeline with stderr", `cd src |& ${TARGET}`],
	["background job", `cd src & ${TARGET}`],
	["line break", `cd src\n${TARGET}`],
	["subshell", `cd src; (${TARGET})`],
	["brace group", `cd src; { ${TARGET}; }`],
	["command substitution", `cd $(${TARGET})`],
	["quoted command substitution", `cd "$(${TARGET})"`],
	["backtick substitution", `cd \`${TARGET}\``],
	["process substitution", `cd <(${TARGET})`],
	["here-string substitution", `cd <<< "$(${TARGET})"`],
	["here-document substitution", `cd <<EOF\n$(${TARGET})\nEOF`],
	["parameter default substitution", `cd \${dir:-$(${TARGET})}`],
	["arithmetic substitution", `cd $(( $(${TARGET}) + 1 ))`],
	["if body", `if cd src; then ${TARGET}; fi`],
	["loop body", `for f in a; do cd src; ${TARGET}; done`],
	["after a redirection", `cd src 2>/dev/null && ${TARGET}`],
	["after a test", `[[ -d src && -d out ]] && ${TARGET}`],
	["substitution that starts with a subshell", `cd $((cd src) ; ${TARGET})`],
];

/** Wrappers that run TARGET; granting the wrapper alone must not allow what it runs. */
const WRAPPER_SHAPES: ReadonlyArray<readonly [string, string]> = [
	["env", `env FOO=1 ${TARGET}`],
	["env with a quoted assignment", `env 'FOO=1' ${TARGET}`],
	["su --command", `su --command='${TARGET}' root`],
	["eval --", `eval -- '${TARGET}'`],
	["command", `command ${TARGET}`],
	["exec", `exec ${TARGET}`],
	["builtin", `builtin eval '${TARGET}'`],
	["nohup", `nohup ${TARGET}`],
	["time", `time ${TARGET}`],
	["nice", `nice -n 5 ${TARGET}`],
	["timeout", `timeout 5 ${TARGET}`],
	["xargs", `xargs ${TARGET}`],
	["sudo", `sudo -u root ${TARGET}`],
	["doas", `doas ${TARGET}`],
	["bash -c", `bash -c '${TARGET}'`],
	["sh -c with flags", `sh -ec "${TARGET}"`],
	["eval", `eval '${TARGET}'`],
	["find -exec", `find . -exec ${TARGET} {} \\;`],
];

const ASKING_PRESETS = ["accept-edits", "ask", "read-only"] as const;

describe("bash permission decides every command a call runs", () => {
	describe.each(ASKING_PRESETS)("%s preset", (preset) => {
		it.each(CHAINED_SHAPES)("asks for a %s after an allowed command", async (_shape, command) => {
			const lead = command.startsWith("[[") ? "[[" : "cd";
			expect(await decide(preset, command, { approved: always(lead) })).toBe("ask");
		});

		it.each(WRAPPER_SHAPES)("asks for what %s runs when only the wrapper is allowed", async (_shape, command) => {
			const wrapper = command.split(" ")[0];
			expect(await decide(preset, command, { approved: always(wrapper, "builtin", "eval") })).toBe("ask");
		});

		it("asks when a configured allow covers only the first command", async () => {
			expect(await decide(preset, `git status && ${TARGET}`, { config: { bash: { "git *": "allow" } } })).toBe(
				"ask",
			);
		});

		it("allows a chain when every command in it is allowed", async () => {
			expect(await decide(preset, "cd src && ls -la | wc -l", { approved: always("cd", "ls", "wc") })).toBe("allow");
		});

		it("asks for a command it cannot parse, whatever single commands are allowed", async () => {
			expect(
				await decide(preset, `cd src; case x in x) ${TARGET};; esac`, { approved: always("cd", "case", "rm") }),
			).toBe("ask");
		});
	});

	describe("full-access preset with a deny rule", () => {
		const config: PermissionConfig = { bash: { "rm *": "deny" } };

		it.each([...CHAINED_SHAPES, ...WRAPPER_SHAPES])("denies the command in a %s", async (_shape, command) => {
			expect(await decide("full-access", command, { config })).toBe("deny");
		});

		it.each([
			["absolute path", `/bin/${TARGET}`],
			["relative path", `./${TARGET}`],
			["quoted name", `'rm' -rf build`],
			["leading assignment", `LANG=C ${TARGET}`],
			["quoted assignment", `LANG="C" ${TARGET}`],
		])("denies the command given by %s", async (_shape, command) => {
			expect(await decide("full-access", command, { config })).toBe("deny");
		});

		it("still denies through the plain words of a command it cannot parse", async () => {
			expect(await decide("full-access", `case x in x) ${TARGET};; esac`, { config })).toBe("deny");
		});

		it("allows an unparsed command no rule denies, since full access never asks", async () => {
			expect(await decide("full-access", "case x in x) ls;; esac", { config })).toBe("allow");
		});
	});
});

describe("bash permission requests", () => {
	it("keeps one prefix pattern for a simple command", () => {
		expect(registry.parse("bash", { command: 'git commit -m "a b"' }, cwd)).toEqual([
			{ permission: "bash", patterns: ["git commit"], always: ["git commit", "git commit *"] },
		]);
	});

	it("asks once for a chain, with one pattern per command, and remembers exactly those", () => {
		expect(registry.parse("bash", { command: "cd src && ls | cd out" }, cwd)).toEqual([
			{ permission: "bash", patterns: ["cd", "ls"], always: ["cd", "cd *", "ls", "ls *"] },
		]);
	});

	it("names a wrapper and the command it runs", () => {
		expect(registry.parse("bash", { command: "sudo -u root /usr/bin/git push" }, cwd)[0]?.patterns).toEqual([
			"sudo",
			"git push",
		]);
	});

	it("gives an unparsed command one exact target and a deny-only check of its words", () => {
		const command = "case x in x) ls;; esac";
		expect(registry.parse("bash", { command }, cwd)).toEqual([
			{ permission: "bash", patterns: ["case", "x", "in", "ls", "esac"], always: [], autoApproveAsk: true },
			{
				permission: "bash",
				patterns: [`${UNPARSED_BASH_PREFIX}${command}`],
				always: [`${UNPARSED_BASH_PREFIX}${command}`],
			},
		]);
	});
});

describe("analyzeBashCommand", () => {
	it.each([
		["git status", [["git", "status"]]],
		["a && b || c; d | e & f", [["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]],
		["echo $(a) `b`", [["a"], ["b"], ["echo", "", ""]]],
		["cat <<'EOF'\n$(a)\nEOF\nb", [["cat"], ["b"]]],
		["cat <<EOF\n$(a)\nEOF\nb", [["cat"], ["a"], ["b"]]],
		["ls 2>&1 >out", [["ls"]]],
		["ls # && a", [["ls"]]],
		["X=1 Y=$(a) b", [["a"], ["b"]]],
		["[ -f x ] && a", [["[", "-f", "x", "]"], ["a"]]],
		["echo $((a) ; b)", [["a"], ["b"], ["echo", ""]]],
		["echo $((1 + 2))", [["echo", ""]]],
	])("splits %j", (command, segments) => {
		expect(analyzeBashCommand(command)).toEqual({ kind: "parsed", segments });
	});

	it.each([
		["an unterminated quote", "echo 'a"],
		["an unterminated substitution", "echo $(a"],
		["a command name from a variable", "$cmd x"],
		["a command name from a glob", "/bin/r? x"],
		["a command name from brace expansion", "{rm,x} y"],
		["a case statement", "case a in a) b;; esac"],
		["a function definition", "f() { a; }"],
		["an unknown wrapper option", "sudo --unknown a"],
		["env -S", "env -S 'a b'"],
		["a dynamic -c script", 'bash -c "$script"'],
	])("refuses %s", (_case, command) => {
		expect(analyzeBashCommand(command)).toEqual({ kind: "unparsed" });
	});
});
