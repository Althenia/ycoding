import { expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionEvent } from "../src/session-event.js"

const decode = <S extends Schema.Decoder<unknown>>(schema: S, value: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value)

const base = { sessionID: "ses_decision_events" }
const source = { messageID: "msg_decision_events", callID: "call_1" }

test("permission assessment records the outcome, authority path, and bounded evidence", () => {
  const value = {
    ...base,
    requestID: "per_1",
    outcome: "allow",
    via: "baseline",
    authority: "baseline",
    reply: "once",
    choice: "allow",
    confidence: 0.91,
    grades: [{ choice: "allow", confidence: 0.91, evidence: "Scoped to the stated work." }],
    source,
  }
  expect<unknown>(decode(SessionEvent.PermissionAssessed.data, value)).toEqual(value)
  expect<unknown>(decode(SessionEvent.PermissionAssessed.data, { ...base, requestID: "per_2", outcome: "escalate", via: "yolo", authority: "yolo", reason: "unsupported-output" }))
    .toMatchObject({ outcome: "escalate", via: "yolo", reason: "unsupported-output" })
})

test("permission assessment rejects forged paths and any operation detail", () => {
  const valid = { ...base, requestID: "per_1", outcome: "deny", via: "auto-permission" }
  expect(() => decode(SessionEvent.PermissionAssessed.data, { ...valid, via: "forged" })).toThrow()
  expect(() => decode(SessionEvent.PermissionAssessed.data, { ...valid, outcome: "approve" })).toThrow()
  for (const key of ["resources", "patterns", "metadata", "command"])
    expect(() => decode(SessionEvent.PermissionAssessed.data, { ...valid, [key]: ["rm -rf /"] })).toThrow()
})

test("decision audit distinguishes cancellation and carries canonical answers without raw output", () => {
  const value = {
    ...base,
    purpose: "answer",
    authority: "yolo",
    agent: "yolo-answer",
    route: "openai-responses",
    outcome: "succeeded",
    fingerprint: "a".repeat(64),
    invocationKey: "que_1:0",
    attempts: 1,
    answers: [
      { name: "question_0", type: "choice", choice: "Fast", confidence: 0.9 },
      { name: "question_1", type: "text", length: 12, confidence: 0.85 },
    ],
  }
  expect<unknown>(decode(SessionEvent.DecisionAudited.data, value)).toEqual(value)
  expect<unknown>(decode(SessionEvent.DecisionAudited.data, { ...base, purpose: "advisory", agent: "decision", outcome: "cancelled", fingerprint: "b", attempts: 1 }))
    .toMatchObject({ outcome: "cancelled" })
  expect(() => decode(SessionEvent.DecisionAudited.data, { ...value, answers: [{ name: "q", type: "text", text: "secret", confidence: 0.9 }] })).toThrow()
  expect(() => decode(SessionEvent.DecisionAudited.data, { ...value, answers: [{ name: "q", type: "choice", confidence: 1.5 }] })).toThrow()
  expect(() => decode(SessionEvent.DecisionAudited.data, { ...value, authority: "admin" })).toThrow()
})

test("guardrail decision keeps an optional authority", () => {
  const value = { ...base, reviewSessionID: "ses_decision_events", requestID: "grd_1", reply: "once", authority: "yolo" }
  expect<unknown>(decode(SessionEvent.GuardrailDecided.data, value)).toMatchObject({ authority: "yolo" })
  expect(() => decode(SessionEvent.GuardrailDecided.data, { ...value, authority: "other" })).toThrow()
})
