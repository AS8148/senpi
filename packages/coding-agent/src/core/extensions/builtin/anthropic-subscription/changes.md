## 2026-10-15 - Transport image elision is hash-neutral in the sent stream (senpi#2768)

### What changed

- `sent-image-slots.ts` (new): `imageNeutralContent` digests every image block and every `IMAGE_ELISION_PLACEHOLDER` text block as one image slot, merging a run of them into one slot as `elideOldImages` merges consecutive placeholders.
- `session-sync.ts`: `sentMessageHashes` hashes user and tool-result content through `imageNeutralContent`. Text and tool output stay hash-significant.

### Why

- The transport image budget (`core/messages.ts` `elideOldImages`, 24 MB) replaces older images with a placeholder as new ones arrive. The resident SDK session already holds every image it was sent, so the swap changes nothing it receives. Hashing it read as `sent_stream_diverged`, flattened the session, and re-sent the whole history with a full prompt-cache miss. Computer use makes this happen on most turns: a screenshot may carry up to 5 MB inline, so the budget fills within a few screenshots. Measured with the real functions over 30 screenshot turns: 24 of 29 turns diverged at 4 MB per screenshot on `main`, 8 of 29 with the stepped cutoff alone, 0 with this change. Regression: `test/suite/regressions/2768-anthropic-subscription-elision-hash-neutral.test.ts`, which also checks that a real rewrite of sent tool output still reports `sent_stream_diverged`.

### Why an extension could not handle it

- This is the extension; the sent-stream digest lives here.

### Known trade-off

- Replacing one image with a different image in an already-sent message no longer reads as divergence. Nothing in senpi rewrites a sent image other than the elision, and the SDK keeps the image it was first sent.

### Expected merge conflict zones

- LOW: the two `content:` lines in `sentMessageHashes`.

