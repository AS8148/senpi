import { IMAGE_ELISION_PLACEHOLDER } from "../../../messages.ts";

const IMAGE_SLOT = { type: "image-slot" } as const;

type HashedContent = string | readonly unknown[];

function isImageOrElided(block: unknown): boolean {
	if (typeof block !== "object" || block === null || !("type" in block)) return false;
	if (block.type === "image") return true;
	return block.type === "text" && "text" in block && block.text === IMAGE_ELISION_PLACEHOLDER;
}

/**
 * The transport image budget (`elideOldImages`) swaps older images for a placeholder, and merges runs of
 * placeholders, as later images arrive (#2768). The resident SDK session already holds every image it
 * was sent, so that swap changes nothing it receives; hashing it would read as `sent_stream_diverged`
 * and re-send the whole conversation. Every image and every elision placeholder therefore digests as one
 * image slot (a run of them as one slot), while text and tool output stay hash-significant.
 */
export function imageNeutralContent(content: HashedContent): HashedContent {
	if (typeof content === "string" || !content.some(isImageOrElided)) return content;
	const normalized: unknown[] = [];
	for (const block of content) {
		if (!isImageOrElided(block)) {
			normalized.push(block);
			continue;
		}
		if (normalized[normalized.length - 1] !== IMAGE_SLOT) normalized.push(IMAGE_SLOT);
	}
	return normalized;
}
