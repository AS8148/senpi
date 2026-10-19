import {
	type Component,
	resetMainScreenHistoryLines,
	type Terminal,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

async function hydrate(): Promise<void> {
	for (let tick = 0; tick < 50; tick++) await new Promise<void>((resolve) => setImmediate(resolve));
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
		// Given: a long regular-mode run of finished tool cards, painted one by one
		const terminal = new RecordingTerminal();
		const tui = new TuiMainScreen(terminal);
		const transcript = new ExplorationTranscriptContainer({
			tailBudget: 60,
			warmChunkSize: 100,
			requestRender: () => {},
		});
		tui.addChild(transcript);
		tui.start();
		const cards: ToolExecutionComponent[] = [];
		for (let index = 0; index < CARDS; index++) {
			const card = finishedBashCard(index);
			cards.push(card);
			transcript.addChild(card);
			tui.renderNow();
		}
		await hydrate();
		tui.renderNow();

		// Then: the first card scrolled far above the window holds no built output, the last one does
		const first = cards[0]!;
		const last = cards.at(-1)!;
		// A card's shell is a spacer, its renderer, its image strip and the renderer's content box.
		expect(descendants(last)).toBeGreaterThan(SHELL);
		expect(descendants(first)).toBe(SHELL);
		tui.stop();

		// When: the user switches to fullscreen, which shows the whole transcript
		const fullscreen = new TuiAltScreen(new RecordingTerminal(), false);
		fullscreen.addChild(transcript);
		fullscreen.start();
		fullscreen.renderNow();
		await hydrate();
		const document = transcript.render(terminal.columns).join("\n");

		// Then: the released card paints exactly what a card that was never released paints, in order
		const expected = finishedBashCard(0).render(terminal.columns).join("\n");
		expect(document).toContain(expected);
		expect(document.indexOf(expected)).toBeLessThan(document.indexOf("run 1"));
		fullscreen.stop();
	});
});
