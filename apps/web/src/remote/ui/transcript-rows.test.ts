import { expect, test } from "bun:test"
import { applySessionEvent, createSessionView, type RemoteMessageView } from "../projection"
import type { GuardrailDecisionView } from "../decision-grades"
import { transcriptRows } from "./transcript-rows"

const decision = (requestID: string, created: number, reply: GuardrailDecisionView["reply"] = "reject"): GuardrailDecisionView => ({ sessionID: "ses_a", requestID, created, reply })
const user = (id: string, created: number): Extract<RemoteMessageView, { kind: "user" }> => ({ kind: "user", id, created, text: id, state: "consumed" })
const keys = (messages: readonly RemoteMessageView[], decisions: readonly GuardrailDecisionView[]) => transcriptRows(messages, decisions).map((row) => row.id)

test("places hydrated rejections before later messages and leaves queued input last", () => {
  expect(keys([user("before", 1), user("later", 9), { ...user("queued", 2), kind: "user", text: "queued", state: "pending" }], [decision("one", 3), decision("two", 4)]))
    .toEqual(["before", "guardrail:one", "guardrail:two", "later", "queued"])
})

test("renders no settled row without resident chat, including while only pending input or a compaction is resident", () => {
  expect(keys([], [decision("retained", 3)])).toEqual([])
  expect(keys([{ ...user("queued", 2), state: "pending" }], [decision("retained", 3)])).toEqual(["queued"])
  expect(keys([{ kind: "compaction", id: "compact", status: "running", created: 1 }], [decision("retained", 3)])).toEqual(["compact"])
})

test("approved decisions never render while a rejection interleaves chronologically", () => {
  const decisions = [decision("once", 3, "once"), decision("blocked", 4), decision("always", 5, "always")]
  expect(keys([user("before", 1), user("later", 9)], decisions)).toEqual(["before", "guardrail:blocked", "later"])
  expect(keys([user("before", 1), user("later", 9)], [decision("once", 3, "once"), decision("always", 5, "always")])).toEqual(["before", "later"])
})

test("a rejection older than the first resident message is omitted and one at or after it renders", () => {
  expect(keys([user("first", 10), user("second", 20)], [decision("older", 9), decision("at", 10), decision("between", 15)])).toEqual(["guardrail:at", "first", "guardrail:between", "second"])
})

test("live replied and durable decided events yield one row per request before later text", () => {
  let view = createSessionView("ses_a")
  for (const type of ["guardrail.replied", "session.guardrail.decided"]) view = applySessionEvent(view, { type, created: 3, data: { ...decision("one", 3), reviewSessionID: "ses_a", decidedBy: "decision-model" } }, 3)
  expect(keys([user("early", 1), user("later", 9)], view.guardrailDecisions ?? [])).toEqual(["early", "guardrail:one", "later"])
  expect(view.guardrailDecisions).toHaveLength(1)
})

test("five settlements during a completed tool precede later untimed text with one final segment", () => {
  const messages: readonly RemoteMessageView[] = [{ kind: "assistant", id: "assistant", created: 1, completed: 20, parts: [
    { kind: "tool", callID: "call", name: "shell", status: "completed", started: 2, completed: 10, content: [] },
    { kind: "text", ordinal: 1, text: "Later response" },
  ] }]
  const rows = transcriptRows(messages, Array.from({ length: 5 }, (_, index) => decision(`review${index}`, 3 + index)))
  expect(rows.map((row) => row.id)).toEqual(["assistant", ...Array.from({ length: 5 }, (_, index) => `guardrail:review${index}`), "assistant:text:1"])
  expect(rows.filter((row) => row.kind === "message").map((row) => ({ id: row.message.id, continued: row.continued, parts: row.message.kind === "assistant" ? row.message.parts.map((part) => part.kind) : [] })))
    .toEqual([{ id: "assistant", continued: true, parts: ["tool"] }, { id: "assistant", continued: false, parts: ["text"] }])
})

test("overlapping tools preserve the latest completion before later untimed text", () => {
  const messages: readonly RemoteMessageView[] = [{ kind: "assistant", id: "assistant", created: 1, completed: 40, parts: [
    { kind: "tool", callID: "slow", name: "read", status: "completed", started: 2, completed: 30, content: [] },
    { kind: "tool", callID: "fast", name: "read", status: "completed", started: 3, completed: 10, content: [] },
    { kind: "text", ordinal: 2, text: "After both tools" },
  ] }]
  expect(keys(messages, [decision("overlap", 25)])).toEqual(["assistant", "guardrail:overlap", "assistant:text:2"])
})

test("settled rows start at the first resident chat message, so compacted history and checkpoints hide covered rejections only in display", () => {
  const decisions = [decision("covered", 3), decision("retained", 12)]
  const completed: RemoteMessageView = { kind: "compaction", id: "compact", status: "completed", boundaryMessageID: "covered", created: 20 }
  const checkpoint: RemoteMessageView = { kind: "synthetic", id: "checkpoint", text: "summary", metadata: { compactionCheckpoint: { through: 4 } }, created: 20 }
  for (const marker of [completed, checkpoint]) {
    expect(keys([marker, user("retained", 10)], decisions)).toEqual([...(marker.kind === "compaction" ? ["compact"] : []), "retained", "guardrail:retained"])
    expect(keys([marker], decisions)).toEqual(marker.kind === "compaction" ? ["compact"] : [])
  }
  expect(decisions.map((item) => item.requestID)).toEqual(["covered", "retained"])
  expect(keys([{ ...completed, status: "running" }, user("retained", 10)], decisions)).toEqual(["compact", "retained", "guardrail:retained"])
})
