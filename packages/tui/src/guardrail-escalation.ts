export * as GuardrailEscalation from "./guardrail-escalation.js"

import { Guardrail } from "@ycoding-ai/schema/guardrail"

export function text(input: Guardrail.Escalation) {
  return Guardrail.escalationText(input)
}
