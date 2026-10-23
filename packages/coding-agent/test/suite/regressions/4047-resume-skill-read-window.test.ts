import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const readGate = vi.hoisted(() => ({
	path: "",
	entered: () => {},
	released: Promise.resolve(),
}));

vi.mock("../../../src/core/skill-access.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/skill-access.ts")>();
	return {
		...actual,
		readSkillFileChecked: async (...args: Parameters<typeof actual.readSkillFileChecked>) => {
			if (args[0] === readGate.path) {
				readGate.path = "";
				readGate.entered();
				await readGate.released;
			}
			return actual.readSkillFileChecked(...args);
		},
	};
});

describe("senpi#4047 input held during a resume skill read", () => {
	let harness: Harness | undefined;
	let root: string | undefined;
	let releaseRead: (() => void) | undefined;

	afterEach(async () => {
		releaseRead?.();
		await harness?.session.abort();
		harness?.cleanup();
		if (root !== undefined) rmSync(root, { recursive: true, force: true });
	});

	it.each(["new input", "replacement input"])("delivers %s without needing another release", async (kind) => {
		// Given raw skill input held by a parent's run, with only a newer local Stop left to release.
		root = mkdtempSync(join(tmpdir(), "senpi-4047-"));
		const filePath = join(root, "SKILL.md");
		writeFileSync(filePath, "SYNTHETIC_SKILL_BODY");
		const baseDir = root;
		harness = await createHarness({
			resourceLoader: {
				...createTestResourceLoader(),
				getSkills: () => ({
					skills: [
						{
							name: "carrier",
							description: "Synthetic skill",
							filePath,
							baseDir,
							disableModelInvocation: false,
							sourceInfo: createSyntheticSourceInfo(filePath, { source: "local" }),
						},
					],
					diagnostics: [],
				}),
			},
		});
		harness.setResponses([fauxAssistantMessage("resumed")]);
		const session = harness.session;
		const paused = await session.pauseForRun({
			parentSessionId: "parent",
			parentPauseSeq: 1,
			runRef: { kind: "dag", id: "run" },
		});
		if (!("childSeq" in paused)) throw new Error("run pause refused");
		await session.prompt("/skill:carrier", { clientMessageId: "skill-input" });
		if (kind === "replacement input") session.holdInput({ inputId: "old", revision: 0, text: "old input" });
		await session.stop();
		await session.resumeForRun({
			parentSessionId: "parent",
			parentPauseSeq: 1,
			childSeqCutoff: paused.childSeq,
		});
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		readGate.path = filePath;
		readGate.entered = entered.resolve;
		readGate.released = released.promise;
		releaseRead = released.resolve;

		// When new guidance arrives while the released resume is preparing the skill.
		const resume = session.resumeSessionRequest({});
		await entered.promise;
		if (kind === "replacement input") expect(session.withdrawHeldInput("old")).toBe(true);
		expect(session.holdInput({ inputId: "late", revision: 0, text: "latest guidance" }).kind).toBe("held");
		released.resolve();
		await resume;
		await session.waitForIdle();

		// Then that same turn delivers and consumes the guidance, not a future release that may never happen.
		expect(JSON.stringify(harness.faux.getCallLog().at(-1)?.context.messages)).toContain("latest guidance");
		expect(JSON.stringify(harness.faux.getCallLog().at(-1)?.context.messages)).not.toContain("old input");
		expect(session.pausedHeldInputCount).toBe(0);
	});
});
