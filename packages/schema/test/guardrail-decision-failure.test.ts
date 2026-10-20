import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "../src/guardrail.js"
import { Permission } from "../src/permission.js"

test("guardrail escalation retains typed failure reasons without manufacturing a judgment", () => {
  for (const reason of ["unsupported-output", "invalid-output", "truncated-output", "provider-failed", "timeout", "refused"] as const) {
    const value = Schema.decodeUnknownSync(Guardrail.Escalation)({ reason })
    expect(value).toEqual({ reason })
    expect(value).not.toHaveProperty("choice")
    expect(value).not.toHaveProperty("confidence")
    expect(value).not.toHaveProperty("grades")
  }
  expect(() => Schema.decodeUnknownSync(Guardrail.Escalation)({ reason: "made-up-reason" }, { onExcessProperty: "error" })).toThrow()
})

test("guardrail failure descriptions distinguish unavailable decisions from model escalation", () => {
  const failure = Guardrail.escalationText({ reason: "timeout" })
  expect(failure).toContain("Decision unavailable")
  expect(failure).toContain("timed out")
  expect(failure).not.toContain("model escalated")
  expect(failure).not.toContain("unreported")
  const escalation = Guardrail.escalationText({ reason: "escalated", choice: "escalate", confidence: 0.9 })
  expect(escalation).toContain("Decision model escalated")
  expect(escalation).toContain("choice escalate")
  expect(escalation).toContain("confidence 0.9")
})

test("an empty historical escalation reports missing diagnostics rather than an invented model choice", () => {
  expect(Schema.decodeUnknownSync(Guardrail.Escalation)({})).toEqual({})
  const description = Guardrail.escalationText({})
  expect(description).toContain("diagnostic reason was not recorded")
  expect(description).not.toContain("choice")
  expect(description).not.toContain("confidence")
})

test("unsupported strict decisions identify the failure and the available human action", () => {
  const text = Guardrail.escalationText({ reason: "unsupported-output" })
  expect(text).toContain("strict structured decisions")
  expect(text).toContain("Review this request manually")
  expect(text).toContain("configure a decision helper")
})

test("uncertain and failed assessments never leave the user without a next action", () => {
  for (const reason of ["unavailable", "invalid-output", "refused", "timeout", "conflicting_grades", "low_confidence", "escalated"] as const)
    expect(Guardrail.escalationText({ reason })).toContain("Review this request manually")
})

test("baseline assessment preserves exact allow, deny and escalate identities and evidence", () => {
  const grades = [
    { choice: "allow", confidence: 0.1, evidence: "Authorization is incomplete." },
    { choice: "deny", confidence: 0.2, evidence: "No explicit prohibition is established." },
    { choice: "escalate", confidence: 0.9, evidence: "The owner must resolve the target scope." },
  ]
  expect<unknown>(Schema.decodeUnknownSync(Guardrail.Escalation)({ reason: "escalated", choice: "escalate", confidence: 0.9, grades }))
    .toEqual({ reason: "escalated", choice: "escalate", confidence: 0.9, grades })
})

test("permission requests expose typed escalation without manufacturing a model choice", () => {
  const request = {
    id: "per_assessment",
    sessionID: "ses_assessment",
    action: "shell",
    resources: ["synthetic operation"],
    escalation: { reason: "unsupported-output" },
  }
  expect<unknown>(Schema.decodeUnknownSync(Permission.Request, { onExcessProperty: "error" })(request)).toEqual(request)
  expect(() => Schema.decodeUnknownSync(Permission.Request, { onExcessProperty: "error" })({
    ...request, escalation: { reason: "unsupported-output", choice: "unknown" },
  })).toThrow()
})

test("assessment provenance distinguishes baseline from YOLO without accepting a forged authority", () => {
  for (const authority of ["baseline", "yolo"]) {
    const escalation = { authority, reason: "unsupported-output" }
    expect<unknown>(Schema.decodeUnknownSync(Guardrail.Escalation, { onExcessProperty: "error" })(escalation))
      .toEqual(escalation)
    const decoded = Schema.decodeUnknownSync(Guardrail.Escalation)(escalation)
    expect(Guardrail.escalationText(decoded)).toContain(authority === "baseline" ? "Baseline assessment" : "YOLO assessment")
  }
  expect(() => Schema.decodeUnknownSync(Guardrail.Escalation, { onExcessProperty: "error" })({
    authority: "human-approved", reason: "unsupported-output",
  })).toThrow()
  expect(Schema.decodeUnknownSync(Guardrail.Escalation)({ reason: "refused" })).not.toHaveProperty("authority")
})

test("live guardrail decisions and status reads preserve model authority", () => {
  const outcome = {
    rootSessionID: "ses_assessment",
    sessionID: "ses_assessment",
    requestID: "grq_assessment",
    reply: "reject",
    decidedBy: "decision-model",
    authority: "baseline",
  }
  expect<unknown>(Schema.decodeUnknownSync(Guardrail.Event.Replied.data, { onExcessProperty: "error" })(outcome))
    .toEqual(outcome)
  const status = Schema.decodeUnknownSync(Guardrail.Status, { onExcessProperty: "error" })({
    rootSessionID: "ses_assessment", profile: "standard", customRules: 0, approvals: 0, blocked: 0,
    counters: [], invalidFiles: [], decisions: [{
      sessionID: "ses_assessment", requestID: "grq_assessment", created: 1, reply: "reject", authority: "baseline",
    }],
  })
  expect(status.decisions?.[0]).toHaveProperty("authority", "baseline")
})
