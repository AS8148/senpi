import { describe, it } from "vitest";

import {
	expectLeakMatchEverywhere,
	expectNoLeakMatchEverywhere,
	runSplitMatrix,
	sgml,
} from "./control-leak-helpers.ts";

// senpi#3880: `s` and `mask` are tokenizer special tokens AND ordinary markup (HTML strikethrough,
// SVG mask). Markup uses of them must never abort a reply; a leaked unquoted `</s>` EOS run still must.
const FENCE = "`".repeat(3);

describe("control-token-leak and markup that spells a special token (senpi#3880)", () => {
	it("nested HTML strikethrough is markup", () => {
		const fixture = `${sgml("s").repeat(4)}text${sgml("/s").repeat(4)}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [sgml("s"), sgml("/s")]));
	});

	it("nested SVG mask is markup", () => {
		const fixture = `${sgml("mask").repeat(4)}content${sgml("/mask").repeat(4)}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [sgml("mask"), sgml("/mask")]));
	});

	it("a fenced SVG example of mask closers is a documented example", () => {
		const fixture = `${FENCE}svg\n${sgml("/mask").repeat(8)}\n${FENCE}`;
		expectNoLeakMatchEverywhere(runSplitMatrix(fixture, [sgml("/mask")]));
	});

	it("closers beyond the opened markup still fire as a leaked EOS run", () => {
		const open = sgml("s");
		const close = sgml("/s");
		const fixture = `${open}struck${close} and then ${close.repeat(4)}`;
		expectLeakMatchEverywhere(runSplitMatrix(fixture, [open, close]), {
			tokenId: "sgml:/s",
			occurrences: 4,
			context: "normal",
			anomalyStartOffset: fixture.indexOf(close.repeat(4)),
		});
	});
});
