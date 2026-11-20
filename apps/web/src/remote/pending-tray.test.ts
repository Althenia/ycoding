import { describe, expect, test } from "bun:test"
import { applySessionEvent, createSessionView, readPendingInputs, reconcilePendingInputs, type RemoteMessageView } from "./projection"
import { pendingTrayItems } from "./view-model"

const user = (id: string, text: string, state: "pending" | "promoted" | "consumed" = "pending", delivery: "steer" | "queue" = "queue"): Extract<RemoteMessageView, { kind: "user" }> => ({ kind: "user", id, text, state, delivery, created: 1 })

describe("pending tray selection", () => {
  test("keeps only admitted user-authored queued messages in order", () => {
    const messages: readonly RemoteMessageView[] = [
      user("msg_done", "Already sent", "consumed"),
      user("msg_a", "First queued"),
      { kind: "synthetic", id: "msg_json", text: "{\"internal\":true}", description: "Internal", pending: true, delivery: "queue", created: 2 },
      user("msg_note", "Subagent notification: finished"),
      user("msg_project", "Project notification: step"),
      user("msg_blank", "   "),
      user("msg_sending", "Not admitted yet"),
      user("msg_b", "Second steer", "pending", "steer"),
    ]
    expect(pendingTrayItems(messages, new Set(["msg_sending"]))).toEqual([
      { id: "msg_a", text: "First queued" },
    ])
  })

  test("labels an attachment-only message and hides an empty one", () => {
    const attachment = { name: "shot.png", mime: "image/png", digest: "a".repeat(64), bytes: 10 }
    expect(pendingTrayItems([{ ...user("msg_img", "[Image 1]"), attachments: [attachment] }])).toEqual([{ id: "msg_img", text: "Attachment" }])
    expect(pendingTrayItems([user("msg_empty", "")])).toEqual([])
  })
})

describe("pending input reads and events", () => {
  const row = (id: string, text: string) => ({ id, sessionID: "ses_a", timeCreated: 1, type: "user", delivery: "queue", data: { text } })

  test("a pending compaction row does not discard the user rows", () => {
    const read = readPendingInputs({ data: [row("msg_a", "First"), { id: "msg_c", sessionID: "ses_a", timeCreated: 2, type: "compaction", delivery: "queue" }] }, "ses_a")
    expect(read?.map((message) => message.id)).toEqual(["msg_a"])
    expect(readPendingInputs({ data: [row("msg_a", "First"), { nonsense: true }] }, "ses_a")).toBeUndefined()
  })

  test("a refreshed list drops a removed input and keeps the rest", () => {
    const first = reconcilePendingInputs(createSessionView("ses_a"), readPendingInputs({ data: [row("msg_a", "First"), row("msg_b", "Second")] }, "ses_a")!)
    const next = reconcilePendingInputs(first, readPendingInputs({ data: [row("msg_b", "Second")] }, "ses_a")!)
    expect(pendingTrayItems(next.messages).map((item) => item.id)).toEqual(["msg_b"])
  })

  test("withdrawn removes the pending message and steered switches its delivery", () => {
    const view = reconcilePendingInputs(createSessionView("ses_a"), readPendingInputs({ data: [row("msg_a", "First"), row("msg_b", "Second")] }, "ses_a")!)
    const steered = applySessionEvent(view, { type: "session.input.steered", data: { sessionID: "ses_a", inputID: "msg_a" } }, 5)
    expect(pendingTrayItems(steered.messages)).toEqual([{ id: "msg_b", text: "Second" }])
    expect(steered.messages.find((message) => message.id === "msg_a")).toMatchObject({ delivery: "steer", state: "pending" })
    const withdrawn = applySessionEvent(steered, { type: "session.input.withdrawn", data: { sessionID: "ses_a", inputID: "msg_b" } }, 6)
    expect(pendingTrayItems(withdrawn.messages)).toEqual([])
    expect(withdrawn.messages.map((message) => message.id)).toEqual(["msg_a"])
  })
})
