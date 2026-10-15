import { expect, test } from "bun:test"
import { hasCompactionCheckpoint, transcriptMessageVisible, type RemoteMessageView } from "./projection"

test("a synthetic checkpoint is a hidden paging stop without a lifecycle row", () => {
  const checkpoint: RemoteMessageView = {
    kind: "synthetic",
    id: "checkpoint",
    text: "summary",
    description: "Compaction checkpoint",
    metadata: { compactionCheckpoint: { manifestDigest: "digest", through: 4 } },
    created: 1,
  }
  expect(transcriptMessageVisible(checkpoint)).toBe(false)
  expect(hasCompactionCheckpoint([checkpoint])).toBe(true)
  const notice = { ...checkpoint, id: "notice", metadata: {} }
  expect(transcriptMessageVisible(notice)).toBe(true)
  expect(hasCompactionCheckpoint([notice])).toBe(false)
})
