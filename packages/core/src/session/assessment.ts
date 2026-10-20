export * as SessionAssessment from "./assessment"

import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Option, Schema } from "effect"
import type { DecisionChoice } from "../decision-choice"

export interface Policy {
  readonly authority: Guardrail.Authority
  readonly approvals: ReadonlyArray<{ readonly choice: Guardrail.DecisionChoice; readonly minimum: number; readonly reply: "once" | "always" }>
  readonly denial: { readonly choice: Guardrail.DecisionChoice; readonly minimum: number }
  readonly escalate: Guardrail.DecisionChoice
  readonly approvable: boolean
}

export type Result =
  | { readonly type: "approve"; readonly reply: "once" | "always"; readonly provenance: Guardrail.Escalation }
  | { readonly type: "deny"; readonly provenance: Guardrail.Escalation }
  | { readonly type: "escalate"; readonly provenance: Guardrail.Escalation }

export const policy = (authority: Guardrail.Authority, approvable: boolean): Policy => ({
  authority,
  approvals: [{ choice: "allow", minimum: 0.8, reply: "once" }],
  denial: { choice: "deny", minimum: 0.8 },
  escalate: "escalate",
  approvable,
})

export const choices = (policy: Policy) => [
  ...policy.approvals.map((item) => item.choice),
  policy.denial.choice,
  policy.escalate,
]

const decodeGrades = Schema.decodeUnknownOption(Schema.Array(Guardrail.Grade))

export function interpret(outcome: DecisionChoice.GradedOutcome, policy: Policy): Result {
  if (outcome.type === "unsettled") return { type: "escalate", provenance: { authority: policy.authority, reason: outcome.reason } }
  const listed = choices(policy)
  const grades = decodeGrades(outcome.grades)
  if (
    Option.isNone(grades) ||
    grades.value.length !== listed.length ||
    !listed.every((choice) => grades.value.filter((grade) => grade.choice === choice).length === 1)
  )
    return { type: "escalate", provenance: { authority: policy.authority, reason: "invalid-output" } }
  const ranked = grades.value.toSorted((left, right) => right.confidence - left.confidence)
  const top = ranked[0]!.confidence
  const approval = ranked.flatMap((grade) => {
    const match = policy.approvals.find((item) => item.choice === grade.choice)
    return match && grade.confidence >= match.minimum ? [{ grade, reply: match.reply }] : []
  })[0]
  const denial = ranked.find((grade) => grade.choice === policy.denial.choice && grade.confidence >= policy.denial.minimum)
  const modelEscalated = ranked.some((grade) => grade.choice === policy.escalate && grade.confidence >= top)
  const provenance = (selected: Guardrail.Grade | undefined, reason?: Guardrail.EscalationReason): Guardrail.Escalation => ({
    authority: policy.authority,
    ...(reason === undefined ? {} : { reason }),
    ...(selected === undefined ? {} : { choice: selected.choice, confidence: selected.confidence }),
    grades: grades.value,
  })
  const escalate = (reason: Guardrail.EscalationReason): Result => ({
    type: "escalate",
    provenance: provenance(ranked.find((grade) => grade.choice === policy.escalate && grade.confidence === top) ?? ranked[0], reason),
  })
  if (modelEscalated) return escalate("escalated")
  if (approval && denial) return escalate("conflicting_grades")
  if (denial) return { type: "deny", provenance: provenance(denial) }
  if (approval && policy.approvable) return { type: "approve", reply: approval.reply, provenance: provenance(approval.grade) }
  return escalate(approval ? "escalated" : "low_confidence")
}
