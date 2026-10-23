import { expect, test } from "bun:test"
import { Schema } from "effect"
import { CoordinationTool } from "../src/tool/coordination"
import { CoordinationAccess } from "../src/session/coordination-access"

const decode = Schema.decodeUnknownSync(CoordinationTool.Input, { onExcessProperty: "error" })

test("project exposes only list, send, answer, interrupt without caller or group overrides", () => {
  expect(CoordinationTool.name).toBe("project")
  expect(decode({ action: "list" })).toEqual({ action: "list" })
  expect(decode({ action: "send", sessionID: "ses_member", text: "Inspect" })).toMatchObject({ action: "send" })
  expect(decode({ action: "interrupt", sessionID: "ses_member" })).toMatchObject({ action: "interrupt" })
  for (const action of ["create", "update", "delete", "get", "arm", "stop", "complete", "claim", "release", "dispatch", "receipts", "wait", "cancelWait", "capacity", "inspect", "decide"])
    expect(() => decode({ action })).toThrow()
  for (const extra of [{ groupID: "cgrp_other" }, { caller: "ses_other" }, { actor: { kind: "human" } }])
    expect(() => decode({ action: "list", ...extra })).toThrow()
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

test("scope gating denies only the project tool", () => {
  expect(CoordinationAccess.rules(true)).toEqual([])
  expect(CoordinationAccess.rules(false)).toEqual([{ action: "project", resource: "*", effect: "deny" }])
})
