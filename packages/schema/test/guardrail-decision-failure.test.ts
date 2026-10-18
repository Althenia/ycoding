import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "../src/guardrail.js"

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
