/**
 * How far the last frame's visible rows moved down in the new frame because rows were inserted above them.
 *
 * A held repaint writes the frame from a start row and lets the rows above the screen scroll into the
 * terminal's scrollback. Rows that sat above the old viewport are already there, so after an insertion
 * above the viewport (a live tool card growing over a tall /btw panel, senpi#3649) the repaint must start
 * where the old viewport's rows went, or every frame pushes another copy of them.
 *
 * A shift counts only when the rows it would skip are exactly the rows already in the scrollback right above
 * the old viewport, at least one of them differs from the row the old frame had at that position (identical
 * rows across the viewport top, as in a run of repeated lines, are no evidence of a move), and most of the
 * old visible rows reappear at it. A majority alone is not enough: a tall
 * stable live area matches at any offset after an append, while rows re-laid out in place (a streamed table,
 * #2836) are new rows that must still scroll into the scrollback, so the start stays at the old viewport top.
 */
export function insertedAboveViewport(
	previousLines: readonly string[],
	newLines: readonly string[],
	prevViewportTop: number,
	height: number,
	lineCountDelta: number,
): number {
	if (lineCountDelta <= 0) return 0;
	const visibleMatchesAt = (shift: number): number => {
		let matches = 0;
		for (let row = 0; row < height; row++) {
			const previous = previousLines[prevViewportTop + row];
			if (previous !== undefined && previous === newLines[prevViewportTop + shift + row]) matches += 1;
		}
		return matches;
	};
	const skipsOnlyScrolledRows = (shift: number): boolean => {
		let movedAtPosition = false;
		for (let row = 0; row < shift; row++) {
			const skipped = newLines[prevViewportTop + row];
			const scrolled = previousLines[prevViewportTop - shift + row];
			if (scrolled === undefined || scrolled !== skipped) return false;
			if (skipped !== previousLines[prevViewportTop + row]) movedAtPosition = true;
		}
		return movedAtPosition;
	};
	let best = 0;
	let bestMatches = visibleMatchesAt(0);
	for (let shift = 1; shift <= Math.min(lineCountDelta, prevViewportTop); shift++) {
		if (!skipsOnlyScrolledRows(shift)) continue;
		const matches = visibleMatchesAt(shift);
		if (matches > bestMatches) {
			best = shift;
			bestMatches = matches;
		}
	}
	return bestMatches * 2 > height ? best : 0;
}
