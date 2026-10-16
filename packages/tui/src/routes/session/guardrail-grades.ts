import type { GuardrailGrade } from "@ycoding-ai/client"
import { escapeTerminalText } from "../../util/terminal-text"

export function guardrailGradeDetails(grades: readonly GuardrailGrade[] | undefined, choice?: string) {
  return (grades ?? []).map((grade) => ({
    label: `grade ${grade.choice.replaceAll("_", " ")}${grade.choice === choice ? " (selected)" : ""}`,
    value: `${grade.confidence.toString()} · ${escapeTerminalText(grade.evidence)}`,
  }))
}
