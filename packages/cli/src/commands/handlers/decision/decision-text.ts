import type { DecisionItem } from "@ycoding-ai/client/promise"
import { shellCommand } from "../../decision"

export const line = (value: string) => value.replaceAll(/[\u0000-\u001f\u007f]/g, " ")

export function decisionText(item: DecisionItem) {
  const lines = [`${item.kind} ${item.id} in "${line(item.sessionTitle)}" (${item.sessionID}): ${line(item.summary)}`]
  for (const choice of item.decide) {
    lines.push(`  ${line(choice.label)}${choice.template ? " [template]" : ""}: ${shellCommand(choice.argv)}`)
    if (choice.hint) lines.push(`    ${line(choice.hint)}`)
  }
  return lines.join("\n")
}
