import { expect, test } from "bun:test"
import { residentCapturedMessages, summarizeCapturedChanges } from "../src/file-change-summary"
const first = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new"
const second = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-before\n+after"
const edit = (id: string, file: string, patch: string, name = "edit") => ({ id, type: "assistant", time: { created: 2, completed: 3 }, content: [
  { type: "tool", name, state: { status: "completed", structured: { files: [{ file, patch, additions: 65, deletions: 3, status: "modified" }] } } },
] })

test("shares first-seen parent/child aggregation with counts derived from every displayed patch", () => {
  const summary = summarizeCapturedChanges(
    [edit("msg_parent", "src/a.ts", first), { id: "msg_reply", type: "assistant", time: { created: 5, completed: 6 }, content: [] }],
    [[edit("msg_child", "src/a.ts", second, "apply_patch"), edit("msg_other", "src/b.ts", first)]],
    [],
  )
  expect(summary).toMatchObject({ mode: "transcript", placementMessageID: "msg_reply", files: [
    { path: "src/a.ts", additions: 2, deletions: 2, files: [{ diff: first, additions: 1, deletions: 1 }, { diff: second, additions: 1, deletions: 1 }] },
    { path: "src/b.ts", additions: 1, deletions: 1 },
  ] })
})

test("compaction removes earlier edits before the later completed reply", () => {
  const messages = [edit("msg_old", "src/a.ts", first),
    { id: "msg_compact", type: "compaction", status: "completed", boundary: { messageID: "msg_old" } },
    { id: "msg_reply", type: "assistant", time: { created: 5, completed: 6 }, content: [] }]
  expect(summarizeCapturedChanges(residentCapturedMessages(messages), [], [{ path: "src/a.ts", patch: first, additions: 65, deletions: 3 }])).toEqual({ mode: "none", files: [] })
})

test("uses only parseable latest ledger patches when no completed assistant survives compaction", () => {
  const messages = [{ id: "msg_compact", type: "compaction", status: "completed" }]
  expect(summarizeCapturedChanges(messages, [], [
    { path: "src/a.ts", patch: first, additions: 65, deletions: 3 },
    { path: "binary.png", patch: "Binary files differ", additions: 5, deletions: 0 },
  ])).toMatchObject({ mode: "recovery", placementMessageID: "msg_compact", files: [{ path: "src/a.ts", additions: 1, deletions: 1 }] })
})
