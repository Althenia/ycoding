export type GradeView = { readonly choice: string; readonly confidence: number; readonly evidence: string }
export type DecisionProvenanceView = { readonly choice?: string; readonly confidence?: number; readonly grades?: readonly GradeView[] }
export type GuardrailDecisionView = DecisionProvenanceView & {
  readonly sessionID: string
  readonly requestID: string
  readonly created: number
  readonly reply: "once" | "always" | "reject"
  readonly ruleIDs?: readonly string[]
}

const choices = ["approve_all", "approve", "reject", "escalate"]

export function readGrades(value: unknown): readonly GradeView[] | undefined {
  if (!Array.isArray(value)) return undefined
  const grades = value.flatMap((grade): readonly GradeView[] => record(grade) && typeof grade.choice === "string" && grade.choice.trim() !== "" &&
    confidence(grade.confidence) && typeof grade.evidence === "string" && grade.evidence.trim() !== "" && grade.evidence.length <= 500
    ? [{ choice: grade.choice, confidence: grade.confidence, evidence: grade.evidence }] : [])
  return grades.length === value.length ? grades : undefined
}

export function readGuardrailProvenance(value: unknown): DecisionProvenanceView | undefined {
  if (!record(value)) return undefined
  if (value.choice !== undefined && (typeof value.choice !== "string" || !choices.includes(value.choice))) return undefined
  if (value.confidence !== undefined && !confidence(value.confidence)) return undefined
  const grades = readGrades(value.grades)
  return {
    ...(typeof value.choice === "string" ? { choice: value.choice } : {}),
    ...(confidence(value.confidence) ? { confidence: value.confidence } : {}),
    ...(grades !== undefined && grades.every((grade) => choices.includes(grade.choice)) ? { grades } : {}),
  }
}

export function readGradedAnswers(value: unknown): readonly { readonly name: string; readonly grades: readonly GradeView[] }[] {
  if (!record(value) || !record(value.response) || !Array.isArray(value.response.answers)) return []
  return value.response.answers.flatMap((answer) => {
    if (!record(answer) || answer.type !== "choice" || typeof answer.name !== "string") return []
    const grades = readGrades(answer.grades)
    return grades?.length ? [{ name: answer.name, grades }] : []
  })
}

export function readGuardrailDecisions(value: unknown, sessionID: string): readonly GuardrailDecisionView[] | undefined {
  if (!record(value) || !record(value.data) || !Array.isArray(value.data.decisions)) return undefined
  return value.data.decisions.flatMap((item): readonly GuardrailDecisionView[] => {
    if (!record(item) || item.sessionID !== sessionID || typeof item.requestID !== "string" || typeof item.created !== "number" ||
      !Number.isFinite(item.created) || item.created < 0 || (item.reply !== "once" && item.reply !== "always" && item.reply !== "reject")) return []
    return [{ sessionID, requestID: item.requestID, created: item.created, reply: item.reply, ...readGuardrailProvenance(item),
      ...(Array.isArray(item.ruleIDs) && item.ruleIDs.every((rule) => typeof rule === "string") ? { ruleIDs: item.ruleIDs } : {}),
    }]
  })
}

export function mergeGuardrailDecisions(prior: readonly GuardrailDecisionView[], incoming: readonly GuardrailDecisionView[]): readonly GuardrailDecisionView[] {
  return [...new Map([...prior, ...incoming].map((item) => [item.requestID, item])).values()]
    .sort((left, right) => left.created - right.created || left.requestID.localeCompare(right.requestID)).slice(-100)
}

export function gradeLabel(choice: string): string {
  return ({ approve_all: "Approve all", approve: "Approve", reject: "Reject", escalate: "Escalate" } as Readonly<Record<string, string>>)[choice] ?? choice
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) }
function confidence(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 }
