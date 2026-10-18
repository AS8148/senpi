/**
 * How far the last frame's visible rows moved down in the new frame because rows were inserted above them.
 *
 * A held repaint writes the frame from a start row and lets the rows above the screen scroll into the
 * terminal's scrollback. Rows that sat above the old viewport are already there, so after an insertion
 * above the viewport (a live tool card growing over a tall /btw panel, senpi#3649) the repaint must start
 * where the old viewport's rows went, or every frame pushes another copy of them. The shift is the offset
 * at which most of the old visible rows reappear; 0 when no offset explains them (rows re-laid out in place).
 */
export function insertedAboveViewport(
	previousLines: readonly string[],
	newLines: readonly string[],
	prevViewportTop: number,
	height: number,
	lineCountDelta: number,
): number {
	if (lineCountDelta <= 0) return 0;
	const matchesAt = (shift: number): number => {
		let matches = 0;
		for (let row = 0; row < height; row++) {
			const previous = previousLines[prevViewportTop + row];
			if (previous !== undefined && previous === newLines[prevViewportTop + shift + row]) matches += 1;
		}
		return matches;
	};
	let best = 0;
	let bestMatches = matchesAt(0);
	for (let shift = 1; shift <= lineCountDelta; shift++) {
		const matches = matchesAt(shift);
		if (matches > bestMatches) {
			best = shift;
			bestMatches = matches;
		}
	}
	return bestMatches * 2 > height ? best : 0;
}
