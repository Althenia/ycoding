import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Guardrail } from "../src/guardrail.js"
import { SessionReview } from "../src/session-review.js"

const failures = [
  ["unavailable", "the decision model or its authenticated route is unavailable"],
  ["invalid-request", "the decision request is invalid"],
  ["provider-failed", "the provider request failed"],
  ["timeout", "the decision request timed out"],
  ["input-too-large", "the decision input exceeds the supported size"],
  ["invalid-output", "the decision response failed validation"],
  ["refused", "the provider or model refused the decision request"],
  ["truncated-output", "the decision response was truncated or did not finish"],
  ["unsupported-output", "the selected route does not support strict structured decisions"],
] as const

test.each(failures)("failure-only provenance retains %s without invented judgments", (reason) => {
  const value = Schema.decodeUnknownSync(Guardrail.Escalation)({ reason })
  expect(value).toEqual({ reason })
  expect(Schema.encodeSync(Guardrail.Escalation)(value)).toEqual({ reason })
  expect(Schema.decodeUnknownSync(SessionReview.Reason)(reason)).toBe(reason)
})

test.each(failures)("failure text identifies %s rather than model escalation", (reason, description) => {
  expect(Guardrail.escalationText({ reason })).toBe(`Decision unavailable · ${description}`)
})

test.each([null, false, 1, "unknown-failure", {}])("invalid diagnostic reason %p is rejected", (reason) => {
  expect(() => Schema.decodeUnknownSync(Guardrail.Escalation)({ reason })).toThrow()
})

test("explicit escalation and uncertain grading remain distinct from helper failure", () => {
  expect(Guardrail.escalationText({ reason: "escalated" })).toBe("Decision model escalated this guardrail review")
  expect(Guardrail.escalationText({ reason: "low_confidence", confidence: 0.71 })).toBe(
    "Decision requires human review · confidence below the approval threshold · confidence 0.71",
  )
  expect(Guardrail.escalationText({ reason: "conflicting_grades" })).toBe(
    "Decision requires human review · conflicting approval and rejection grades",
  )
  expect(Guardrail.escalationText({})).toBe("Decision unavailable · diagnostic reason was not recorded")
})

test("existing selected judgments retain their exact optional fields", () => {
  const value = {
    choice: "approve",
    confidence: 0.93,
    grades: [{ choice: "approve", confidence: 0.93, evidence: "Synthetic evidence" }],
  } as const
  expect(Schema.decodeUnknownSync(Guardrail.Escalation)(value)).toEqual(value)
  for (const reason of ["disabled", "free_text", "low_confidence", "escalated", "error", "sleep_entry", "restart"] as const)
    expect(Schema.decodeUnknownSync(SessionReview.Reason)(reason)).toBe(reason)
})
