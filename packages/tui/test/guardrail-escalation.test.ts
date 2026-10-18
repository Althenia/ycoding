import { expect, test } from "bun:test"
import { GuardrailEscalation } from "../src/guardrail-escalation"

test.each([
  ["unavailable", "the decision model or its authenticated route is unavailable"],
  ["invalid-request", "the decision request is invalid"],
  ["provider-failed", "the provider request failed"],
  ["timeout", "the decision request timed out"],
  ["input-too-large", "the decision input exceeds the supported size"],
  ["invalid-output", "the decision response failed validation"],
  ["refused", "the provider or model refused the decision request"],
  ["truncated-output", "the decision response was truncated or did not finish"],
  ["unsupported-output", "the selected route does not support strict structured decisions"],
])("guardrail failure %s displays its diagnostic without a fabricated judgment", (reason, description) => {
  const provenance = { reason }
  expect(GuardrailEscalation.text(provenance as Parameters<typeof GuardrailEscalation.text>[0])).toBe(
    `Decision unavailable · ${description}`,
  )
})

test("guardrail escalation text distinguishes an explicit handoff, conflicting grades, and missing diagnostics", () => {
  expect(GuardrailEscalation.text({ choice: "escalate", confidence: 0.934567 })).toBe(
    "Decision model escalated this guardrail review · choice escalate · confidence 0.934567",
  )
  const provenance = {
    reason: "conflicting_grades",
    grades: [
      { choice: "approve" as const, confidence: 0.9, evidence: "The scope is verified." },
      { choice: "reject" as const, confidence: 0.9, evidence: "The target needs confirmation." },
    ],
  }
  expect(GuardrailEscalation.text(provenance as Parameters<typeof GuardrailEscalation.text>[0])).toBe(
    "Decision requires human review · conflicting approval and rejection grades",
  )
  expect(GuardrailEscalation.text({})).toBe("Decision unavailable · diagnostic reason was not recorded")
})
