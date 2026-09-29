import { expect, test } from "bun:test"
import { capturedChildSessionIDs, capturedPartPatches, summarizeCapturedChanges } from "../src/file-change-summary"

const first = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new"
const second = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2 +2 @@\n-before\n+after"
const other = "--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1,2 +1,3 @@\n keep\n-x\n+y\n+z"
const sendID = (assistantMessageID: string, callID: string) => `msg_task_send_${assistantMessageID}_${callID}`

const editPart = (file: string, patch: string, status = "completed", name = "edit") => ({
  type: "tool", id: `call_${file}_${patch.length}`, name,
  state: { status, structured: status === "completed" ? { files: [{ file, patch, additions: 65, deletions: 3, status: "modified" }] } : {} },
})
const assistant = (id: string, content: unknown[] = [], completed = true) => ({
  id, type: "assistant", time: { created: 1, ...(completed ? { completed: 2 } : {}) }, content,
}) as Parameters<typeof summarizeCapturedChanges>[0][number]
const user = (id: string) => ({ id, type: "user" })
const synthetic = (id: string, metadata?: Record<string, unknown>) => ({ id, type: "synthetic", metadata })
const summarize = (parent: Parameters<typeof summarizeCapturedChanges>[0], children: Record<string, Parameters<typeof summarizeCapturedChanges>[0]> = {}) =>
  summarizeCapturedChanges(parent, new Map(Object.entries(children)), sendID)

test("merges repeated edits to one path in one prompt segment into one group at its last completed reply", () => {
  const units = summarize([
    user("msg_user"),
    assistant("msg_step_1", [editPart("src/a.ts", first), editPart("src/b.ts", other)]),
    assistant("msg_step_2", [editPart("src/a.ts", second, "completed", "patch")]),
    assistant("msg_reply"),
  ])
  expect(units).toMatchObject([{ placementMessageID: "msg_reply", files: [
    { path: "src/a.ts", additions: 2, deletions: 2, files: [{ diff: first }, { diff: second }] },
    { path: "src/b.ts", additions: 2, deletions: 1 },
  ] }])
  expect(units[0]!.files.map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"])
})

test("keeps each user or steered segment separate and gives an unchanged segment no card", () => {
  const units = summarize([
    user("msg_user_1"), assistant("msg_reply_1", [editPart("src/a.ts", first)]),
    user("msg_user_2"), assistant("msg_reply_2", [{ type: "text", text: "no edits" }]),
    user("msg_steer"), assistant("msg_reply_3", [editPart("src/a.ts", second)]),
  ])
  expect(units).toMatchObject([
    { placementMessageID: "msg_reply_1", files: [{ path: "src/a.ts", additions: 1, deletions: 1, files: [{ diff: first }] }] },
    { placementMessageID: "msg_reply_3", files: [{ path: "src/a.ts", additions: 1, deletions: 1, files: [{ diff: second }] }] },
  ])
})

test("synthetic runtime context and compaction do not split or discard a segment", () => {
  const units = summarize([
    user("msg_old_user"), assistant("msg_old", [editPart("src/a.ts", first)]),
    { id: "msg_compact", type: "compaction", status: "completed", boundary: { messageID: "msg_old" } } as never,
    synthetic("msg_team_view", { source: "team_view" }),
    assistant("msg_reply", [editPart("src/b.ts", other)]),
  ])
  expect(units).toMatchObject([{ placementMessageID: "msg_reply", files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }])
})

test("counts only completed edit tools", () => {
  expect(summarize([user("msg_user"), assistant("msg_reply", [editPart("src/a.ts", first, "error"), editPart("src/b.ts", other, "running")])])).toEqual([])
  expect(summarize([user("msg_user"), assistant("msg_reply", [editPart("src/a.ts", "not a patch")])])).toEqual([])
})

test("keeps a completed edit visible while its step or segment is still running or ended without completing", () => {
  expect(summarize([user("msg_user"), assistant("msg_running", [editPart("src/a.ts", first)], false)])).toMatchObject([
    { placementMessageID: "msg_running", assistantMessageIDs: ["msg_running"], files: [{ path: "src/a.ts" }] },
  ])
  expect(summarize([user("msg_user"), assistant("msg_step", [editPart("src/a.ts", first)]), assistant("msg_next", [{ type: "text", text: "working" }], false)])).toMatchObject([
    { placementMessageID: "msg_next", assistantMessageIDs: ["msg_step", "msg_next"], files: [{ path: "src/a.ts" }] },
  ])
})

const launch = (child: string, status = "completed") => ({ type: "tool", id: "call_launch", name: "subagent", state: { status, structured: { sessionID: child, status } } })
const control = (child: string, id: string, action: string, input: Record<string, unknown> = {}) => ({
  type: "tool", id, name: "subagent_control", state: { status: "completed", input, structured: { action, task: { sessionID: child } } },
})

test("attributes each dispatched child segment to the parent segment whose tool call dispatched it", () => {
  const child = [
    user("msg_task_launch"),
    assistant("msg_child_1", [editPart("src/child.ts", first)]),
    synthetic("msg_progress", { source: "subagent_parent", kind: "message" }),
    assistant("msg_child_2", [editPart("src/child.ts", second)]),
    synthetic("msg_task_send_msg_reply_2_call_send", { source: "subagent_parent", kind: "message" }),
    assistant("msg_child_3", [editPart("src/later.ts", other)]),
    synthetic("msg_task_answer_auto", { source: "subagent_parent", kind: "answer", questionID: "qst_auto" }),
    assistant("msg_child_4", [editPart("src/auto.ts", other)]),
    synthetic("msg_task_answer_parent", { source: "subagent_parent", kind: "answer", questionID: "qst_1" }),
    assistant("msg_child_5", [editPart("src/answered.ts", other)]),
  ]
  const units = summarize([
    user("msg_user_1"), assistant("msg_reply_1", [launch("ses_child")]),
    user("msg_user_2"), assistant("msg_reply_2", [control("ses_child", "call_send", "send")]),
    user("msg_user_3"), assistant("msg_reply_3", [control("ses_child", "call_answer", "answer", { questionID: "qst_1" })]),
    user("msg_user_4"), assistant("msg_reply_4", [control("ses_child", "call_resume", "resume")]),
  ], { ses_child: child })
  expect(units.map((unit) => [unit.placementMessageID, unit.files.map((file) => file.path)])).toEqual([
    ["msg_reply_1", ["src/child.ts"]],
    ["msg_reply_2", ["src/later.ts"]],
    ["msg_reply_3", ["src/answered.ts"]],
  ])
  expect(units[0]!.files[0]).toMatchObject({ additions: 2, deletions: 2 })
})

test("ends a child segment at the next manual user input or answer even when no parent call claims it", () => {
  const child = [
    user("msg_task_launch"), assistant("msg_child_a", [editPart("src/a.ts", first)]),
    user("msg_manual"), assistant("msg_child_b", [editPart("src/b.ts", other)]),
    synthetic("msg_task_send_msg_reply_2_call_send", { source: "subagent_parent", kind: "message" }), assistant("msg_child_c", [editPart("src/c.ts", second)]),
    synthetic("msg_task_answer_auto", { source: "subagent_parent", kind: "answer", questionID: "qst_auto" }), assistant("msg_child_d", [editPart("src/d.ts", other)]),
    synthetic("msg_poll", { source: "subagent_parent", kind: "message" }), { id: "msg_compact", type: "compaction", status: "completed" } as never, assistant("msg_child_e", [editPart("src/e.ts", first)]),
  ]
  const units = summarize([
    user("msg_user_1"), assistant("msg_reply_1", [launch("ses_child")]),
    user("msg_user_2"), assistant("msg_reply_2", [control("ses_child", "call_send", "send")]),
  ], { ses_child: child })
  expect(units.map((unit) => [unit.placementMessageID, unit.files.map((file) => file.path)])).toEqual([
    ["msg_reply_1", ["src/a.ts"]],
    ["msg_reply_2", ["src/c.ts"]],
  ])
})

test("ignores a dispatch whose child message is absent or whose child transcript is unknown", () => {
  const units = summarize([
    user("msg_user"), assistant("msg_reply", [control("ses_child", "call_send", "send"), launch("ses_missing", "running")]),
  ], { ses_child: [user("msg_task_launch"), assistant("msg_child", [editPart("src/child.ts", first)])] })
  expect(units).toEqual([])
})

test("lists direct children named by launch and completed send or answer calls only", () => {
  expect(capturedChildSessionIDs([
    user("msg_user"),
    assistant("msg_a", [launch("ses_a", "running"), control("ses_b", "call_b", "send"), control("ses_c", "call_c", "answer"), control("ses_d", "call_d", "list"), control("ses_a", "call_e", "send")]),
    assistant("msg_b", [{ type: "tool", id: "call_f", name: "subagent_control", state: { status: "error", structured: {} } }]),
  ])).toEqual(["ses_a", "ses_b", "ses_c"])
})

test("derives displayable patches from one completed edit or patch tool part", () => {
  expect(capturedPartPatches(editPart("src/a.ts", first))).toMatchObject([{ path: "src/a.ts", additions: 1, deletions: 1 }])
  expect(capturedPartPatches(editPart("src/a.ts", first, "error"))).toEqual([])
  expect(capturedPartPatches({ type: "tool", name: "shell", state: { status: "completed", structured: { files: [{ file: "src/a.ts", patch: first }] } } })).toEqual([])
})
