export * as GuardrailEscalation from "./guardrail-escalation.js"

import type { Guardrail } from "@ycoding-ai/schema/guardrail"

export function text(input: Guardrail.Escalation) {
  return `Decision model escalated this guardrail review · choice ${input.choice ?? "unreported"} · confidence ${input.confidence?.toString() ?? "unreported"}`
}
