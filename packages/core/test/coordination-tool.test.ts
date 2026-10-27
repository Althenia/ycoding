import { expect, test } from "bun:test"
import { Schema } from "effect"
import { CoordinationTool } from "../src/tool/coordination"
import { CoordinationAccess } from "../src/session/coordination-access"

const decode = Schema.decodeUnknownSync(CoordinationTool.Input, { onExcessProperty: "error" })

const valid = {
  list: { action: "list" },
  inspect: { action: "inspect", sessionID: "ses_member", requestID: "per_one" },
  send: { action: "send", sessionID: "ses_member", text: "Inspect" },
  answer: { action: "answer", sessionID: "ses_member", requestID: "per_one", kind: "permission", fingerprint: "fp", rationale: "In scope" },
  escalate: { action: "escalate", sessionID: "ses_member", requestID: "per_one", kind: "permission", fingerprint: "fp", reason: "Needs the human" },
  interrupt: { action: "interrupt", sessionID: "ses_member" },
  assign: { action: "assign", sessionID: "ses_member", ownerSessionID: "ses_owner" },
  release: { action: "release", sessionID: "ses_member", reason: "completed" },
} as const

test("project exposes only list, inspect, send, answer, escalate, interrupt, assign and release without caller or group overrides", () => {
  expect(CoordinationTool.name).toBe("project")
  for (const payload of Object.values(valid)) expect(decode(payload)).toEqual(payload as never)
  expect(Object.keys(valid)).toEqual(["list", "inspect", "send", "answer", "escalate", "interrupt", "assign", "release"])
  const complete = { sessionID: "ses_member", requestID: "per_one", ownerSessionID: "ses_owner", reason: "completed", text: "Inspect", kind: "permission", fingerprint: "fp", rationale: "In scope" }
  for (const action of ["create", "update", "delete", "get", "arm", "stop", "complete", "claim", "dispatch", "receipts", "wait", "cancelWait", "capacity", "decide", "transfer", "unassign"])
    expect(() => decode({ action, ...complete })).toThrow()
  for (const payload of Object.values(valid))
    for (const extra of [{ groupID: "cgrp_other" }, { caller: "ses_other" }, { actor: { kind: "human" } }, { coordinatorSessionID: "ses_other" }, { metadata: {} }])
      expect(() => decode({ ...payload, ...extra })).toThrow()
})

test("inspect reads one pending request by native identity and nothing else", () => {
  expect(decode({ ...valid.inspect, requestID: "x".repeat(256) })).toMatchObject({ action: "inspect" })
  for (const invalid of [{ requestID: "" }, { requestID: "x".repeat(257) }, { sessionID: "msg_member" }, { kind: "permission" }, { fingerprint: "fp" }, { decision: "decline" }])
    expect(() => decode({ ...valid.inspect, ...invalid })).toThrow()
  expect(() => decode({ action: "inspect", sessionID: "ses_member" })).toThrow()
  expect(() => decode({ action: "inspect", requestID: "per_one" })).toThrow()
})

test("assign names one owner Session and release one of the closed reasons", () => {
  for (const reason of ["completed", "released"]) expect(decode({ ...valid.release, reason })).toEqual({ ...valid.release, reason } as never)
  for (const invalid of [{ ownerSessionID: "" }, { ownerSessionID: "msg_owner" }, { ownerSessionID: ["ses_a", "ses_b"] }, { reason: "completed" }, { sessionID: "msg_member" }])
    expect(() => decode({ ...valid.assign, ...invalid })).toThrow()
  for (const invalid of [{ reason: "" }, { reason: "done" }, { reason: "Released" }, { ownerSessionID: "ses_owner" }, { sessionID: "msg_member" }])
    expect(() => decode({ ...valid.release, ...invalid })).toThrow()
  expect(() => decode({ action: "assign", sessionID: "ses_member" })).toThrow()
  expect(() => decode({ action: "assign", ownerSessionID: "ses_owner" })).toThrow()
  expect(() => decode({ action: "release", sessionID: "ses_member" })).toThrow()
})

test("send accepts delivery, retry identity and optional model, but no selection or lease", () => {
  const input = { action: "send", sessionID: "ses_member", text: "Inspect", delivery: "queue", messageID: "msg_once", model: { providerID: "fixture", id: "model", profile: "work", variant: "high" } }
  expect(decode(input)).toEqual(input as never)
  for (const extra of [{ selection: {} }, { generation: 1 }, { leaseMs: 1000 }, { delivery: "later" }, { text: "" }])
    expect(() => decode({ ...input, ...extra })).toThrow()
})

test("answer requires native identity, fingerprint and rationale", () => {
  const input = { action: "answer", sessionID: "ses_member", kind: "question", requestID: "frm_one", fingerprint: "fp", rationale: "The scope specifies Markdown", confidence: 0.95, answer: { format: "markdown" } }
  expect(decode(input)).toEqual(input as never)
  for (const extra of [{ rationale: " " }, { fingerprint: "" }, { confidence: 1.1 }, { kind: "human" }, { coordinatorSessionID: "ses_other" }])
    expect(() => decode({ ...input, ...extra })).toThrow()
})

test("answer accepts an explicit approve or decline decision", () => {
  const input = { action: "answer", sessionID: "ses_member", kind: "permission", requestID: "per_one", fingerprint: "fp", rationale: "Outside the assigned files" }
  expect(decode({ ...input, decision: "decline" })).toEqual({ ...input, decision: "decline" } as never)
  expect(decode({ ...input, decision: "approve" })).toMatchObject({ decision: "approve" })
  for (const decision of ["reject", "deny", "always", ""]) expect(() => decode({ ...input, decision })).toThrow()
})

test("escalate requires native identity, fingerprint and a bounded reason", () => {
  const input = { action: "escalate", sessionID: "ses_member", kind: "review", requestID: "grq_one", fingerprint: "fp", reason: "Touches deployment config" }
  expect(decode(input)).toEqual(input as never)
  for (const extra of [{ reason: " " }, { reason: "x".repeat(501) }, { fingerprint: "" }, { kind: "human" }, { to: "human" }, { decision: "approve" }])
    expect(() => decode({ ...input, ...extra })).toThrow()
  expect(() => decode({ action: "escalate", sessionID: "ses_member", kind: "review", requestID: "grq_one", fingerprint: "fp" })).toThrow()
})

test("the tool description names the supervision chain", () => {
  expect(CoordinationTool.description).toContain("escalate")
  expect(CoordinationTool.description).toContain("decline")
  for (const text of [
    "Executor children inherit no controller authority.",
    "delegates implementation to executors",
    "inspect:",
    "decline-only (answer may only decline)",
    "Hard, explicit-decision, Manual-mode, and uncertain cases are refused with a reason.",
    "assign: Master only.",
    "release: the Master or the member's owner",
    "arrive directly at the recorded owner",
  ]) expect(CoordinationTool.description).toContain(text)
})

test("scope gating denies only the project tool", () => {
  expect(CoordinationAccess.rules(true)).toEqual([])
  expect(CoordinationAccess.rules(false)).toEqual([{ action: "project", resource: "*", effect: "deny" }])
})
