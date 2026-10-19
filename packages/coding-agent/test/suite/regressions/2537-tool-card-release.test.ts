import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	resetMainScreenHistoryLines,
	type Terminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { ExplorationTranscriptContainer } from "../../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

const CARDS = 120 as const;
const OUTPUT_LINES = 12 as const;
const SHELL = 4 as const;

class RecordingTerminal implements Terminal {
	columns = 100;
	rows = 20;
	kittyProtocolActive = true;
	writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

const fakeUi = { requestRender: () => {} } as TUI;

function finishedBashCard(index: number): ToolExecutionComponent {
	const card = new ToolExecutionComponent(
		"bash",
		`call-${index}`,
		{ command: `run ${index}` },
		{},
		undefined,
		fakeUi,
		process.cwd(),
	);
	const text = Array.from({ length: OUTPUT_LINES }, (_, line) => `card ${index} output line ${line}`).join("\n");
	card.updateResult({ content: [{ type: "text", text }], isError: false }, false);
	return card;
}

/** Components the card still holds under it; a released card keeps only its empty shell. */
function descendants(component: Component): number {
	const children: unknown = Reflect.get(component, "children");
	if (!Array.isArray(children)) return 0;
	return children.reduce((total: number, child: Component) => total + 1 + descendants(child), 0);
}

function assistantReply(index: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: `reply ${index}` }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** Lines an assistant message holds in its private render cache (0 when it holds none). */
function retainedRenderLines(reply: AssistantMessageComponent): number {
	const cache: unknown = Reflect.get(reply, "renderCache");
	const lines: unknown = cache === undefined ? undefined : Reflect.get(cache as object, "lines");
	return Array.isArray(lines) ? lines.length : 0;
}

/** Resolves on the transcript's next render request (hydration publishing its warmed head), or fails after 5 s. */
function nextRenderRequest(transcript: { onRequestRender: (() => void) | undefined }): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no render request within 5 s")), 5000);
		transcript.onRequestRender = () => {
			clearTimeout(timer);
			transcript.onRequestRender = undefined;
			resolve();
		};
	});
}

let previousHistoryLines: string | undefined;

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	previousHistoryLines = process.env.PI_TUI_HISTORY_LINES;
	process.env.PI_TUI_HISTORY_LINES = "60";
	resetMainScreenHistoryLines();
});

afterEach(() => {
	if (previousHistoryLines === undefined) delete process.env.PI_TUI_HISTORY_LINES;
	else process.env.PI_TUI_HISTORY_LINES = previousHistoryLines;
	resetMainScreenHistoryLines();
});

describe("tool cards above the kept main-screen history (#2537)", () => {
	it("drop their built output once they leave the kept window, and paint it again in fullscreen", async () => {
		// Given: a long regular-mode run of assistant replies and finished tool cards, painted one by one
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const signal: { onRequestRender: (() => void) | undefined } = { onRequestRender: undefined };
		const transcript = new ExplorationTranscriptContainer({
			tailBudget: 60,
			warmChunkSize: 100,
			requestRender: () => signal.onRequestRender?.(),
		});
		tui.addChild(transcript);
		tui.start();
		const cards: ToolExecutionComponent[] = [];
		const firstReply = new AssistantMessageComponent(assistantReply(0));
		let lastReply = firstReply;
		for (let index = 0; index < CARDS; index++) {
			if (index > 0) lastReply = new AssistantMessageComponent(assistantReply(index));
			transcript.addChild(lastReply);
			const card = finishedBashCard(index);
			cards.push(card);
			transcript.addChild(card);
			tui.renderNow();
		}

		// Then: the first card scrolled far above the window holds no built output, the last one does
		const first = cards[0]!;
		const last = cards.at(-1)!;
		// A card's shell is a spacer, its renderer, its image strip and the renderer's content box.
		expect(descendants(last)).toBeGreaterThan(SHELL);
		expect(descendants(first)).toBe(SHELL);
		// And: the reply above the window keeps no rendered lines, while the newest reply still does
		expect(retainedRenderLines(firstReply)).toBe(0);
		expect(retainedRenderLines(lastReply)).toBeGreaterThan(0);
		tui.stop();

		// When: the user switches to fullscreen, which shows the whole transcript
		const fullscreen = new TuiAltScreen(new RecordingTerminal(), false);
		fullscreen.addChild(transcript);
		fullscreen.start();
		const warmed = nextRenderRequest(signal);
		fullscreen.renderNow();
		await warmed;
		const document = transcript.render(terminal.columns).join("\n");

		// Then: the released card paints exactly what a card that was never released paints, in order
		const expected = finishedBashCard(0).render(terminal.columns).join("\n");
		expect(document).toContain(expected);
		expect(document.indexOf(expected)).toBeLessThan(document.indexOf("run 1"));
		fullscreen.stop();
	});
});
