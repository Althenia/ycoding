import { expect, test } from "bun:test"
import { escalationText, readGrades, readGuardrailProvenance, readGradedAnswers, readGuardrailDecisions, mergeGuardrailDecisions } from "./decision-grades"

const grades = [
  { choice: "approve_all", confidence: 1, evidence: "Every target is verified." },
  { choice: "approve", confidence: 0.934567, evidence: "This action is bounded." },
  { choice: "reject", confidence: 0, evidence: "No blocking evidence." },
  { choice: "escalate", confidence: 0.2, evidence: "Ask about scope." },
]

test("guardrail provenance retains all four grades and the selected choice without rounding", () => {
  expect(readGuardrailProvenance({ choice: "approve_all", confidence: 1, grades })).toEqual({ choice: "approve_all", confidence: 1, grades })
  expect(readGuardrailProvenance({ choice: "reject", confidence: 0.71 })).toEqual({ choice: "reject", confidence: 0.71 })
  expect(readGuardrailProvenance({})).toEqual({})
})

test("provenance retains a known escalation reason, drops an unknown one, and forges no judgment on failure", () => {
  expect(readGuardrailProvenance({ reason: "timeout" })).toEqual({ reason: "timeout" })
  expect(readGuardrailProvenance({ reason: "escalated", choice: "escalate", confidence: 0.9 })).toEqual({ reason: "escalated", choice: "escalate", confidence: 0.9 })
  expect(readGuardrailProvenance({ reason: "low_confidence", grades })).toEqual({ reason: "low_confidence", grades })
  expect(readGuardrailProvenance({ reason: "raw <script> reason", choice: "approve", confidence: 0.5 })).toEqual({ choice: "approve", confidence: 0.5 })
  const failure = readGuardrailProvenance({ reason: "unsupported-output" })
  expect(failure).not.toHaveProperty("choice")
  expect(failure).not.toHaveProperty("confidence")
  expect(failure).not.toHaveProperty("grades")
})

test("escalation text distinguishes decision failures from an actual model escalation", () => {
  const failure = escalationText({ reason: "timeout" })
  expect(failure).toContain("Decision unavailable")
  expect(failure).toContain("timed out")
  expect(failure).not.toContain("model escalated")
  expect(failure).not.toContain("unreported")
  expect(escalationText({ reason: "low_confidence" })).toContain("requires human review")
  expect(escalationText({ reason: "conflicting_grades" })).toContain("conflicting")
  const escalated = escalationText({ reason: "escalated", choice: "escalate", confidence: 0.9 })
  expect(escalated).toContain("Decision model escalated")
  expect(escalated).toContain("choice escalate")
  expect(escalated).toContain("confidence 0.9")
  const historical = escalationText({})
  expect(historical).toContain("diagnostic reason was not recorded")
  expect(historical).not.toContain("unreported")
  expect(historical).not.toContain("choice")
})

test("grade evidence stays literal at its 500-character boundary and malformed grades are unavailable", () => {
  expect(readGrades([{ choice: "route-a", confidence: 0.5, evidence: "<script>" + "x".repeat(492) }])?.[0]?.evidence).toHaveLength(500)
  for (const grade of [
    { choice: "approve", confidence: -0.01, evidence: "No" },
    { choice: "approve", confidence: 1.01, evidence: "No" },
    { choice: "approve", confidence: NaN, evidence: "No" },
    { choice: "approve", confidence: 0.5, evidence: "x".repeat(501) },
    { choice: "approve", confidence: 0.5, evidence: "  " },
  ]) expect(readGrades([grade])).toBeUndefined()
  expect(readGuardrailProvenance({ grades: [{ choice: "other", confidence: 0.5, evidence: "Other" }] })?.grades).toBeUndefined()
})

test("graded decision answers preserve arbitrary option identities and never select a null choice", () => {
  expect(readGradedAnswers({ response: { answers: [{ name: "route", type: "choice", choice: null, grades: [{ choice: "keep-current", confidence: 0.82, evidence: "No regression." }] }] } }))
    .toEqual([{ name: "route", grades: [{ choice: "keep-current", confidence: 0.82, evidence: "No regression." }] }])
  expect(readGradedAnswers({ response: { answers: [{ name: "route", type: "choice", choice: "keep-current", confidence: 0.82 }] } })).toEqual([])
})

test("guardrail status outcomes retain grades only for the selected owner", () => {
  const own = { sessionID: "ses_a", requestID: "grq_a", created: 3, reply: "always" as const, choice: "approve_all", confidence: 1, grades }
  expect(readGuardrailDecisions({ data: { decisions: [own, { ...own, sessionID: "ses_child", requestID: "grq_child" }] } }, "ses_a")).toEqual([own])
  expect(readGuardrailDecisions({ data: {} }, "ses_a")).toBeUndefined()
})

test("live settlements keep the same newest-100 bound as the guardrail status read", () => {
  const prior = Array.from({ length: 100 }, (_, created) => ({ sessionID: "ses_a", requestID: `grq_${created}`, created, reply: "once" as const }))
  const newest = { sessionID: "ses_a", requestID: "grq_new", created: 100, reply: "reject" as const }
  const rows = mergeGuardrailDecisions(prior, [newest, newest])
  expect(rows).toHaveLength(100)
  expect(rows[0]?.requestID).toBe("grq_1")
  expect(rows.at(-1)).toEqual(newest)
})
