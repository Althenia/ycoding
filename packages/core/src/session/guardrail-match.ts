export * as SessionGuardrailMatch from "./guardrail-match"

import type { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Wildcard } from "../util/wildcard"
import { SessionGuardrailStandard } from "./guardrail-standard"

export interface Input {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  /** Custom source layers ordered from nearest repository scope to user scope. */
  readonly custom?: ReadonlyArray<CustomLayer>
}

export interface CustomLayer {
  readonly rules: Guardrail.Ruleset
  readonly invalidFiles: ReadonlyArray<string>
}

export interface Result {
  readonly decision: Guardrail.RuleDecision
  readonly ruleIDs: ReadonlyArray<string>
  readonly reason?: string
  readonly standard: boolean
}

const readonlyActions = new Set(["read", "glob", "grep", "webfetch", "websearch"])

export function evaluate(input: Input): Result {
  const standard = input.resources.flatMap((resource) => {
    const match = SessionGuardrailStandard.match(input.action, resource)
    return match ? [match] : []
  })
  const standardDeny = standard.find((item) => item.decision === "deny")
  if (standardDeny)
    return { decision: "deny", ruleIDs: [standardDeny.id], reason: standardDeny.reason, standard: true }

  for (const layer of input.custom ?? []) {
    const match = layer.rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) =>
        input.resources.some(
          (resource) =>
            rule.actions.some((action) => Wildcard.match(input.action, action)) &&
            rule.resources.some((pattern) => Wildcard.match(resource, pattern)),
        ),
      )
      .toSorted((left, right) => right.rule.priority - left.rule.priority || left.index - right.index)[0]?.rule
    if (match?.decision === "deny")
      return {
        decision: match.decision,
        ruleIDs: [match.id],
        reason: match.reason,
        standard: false,
      }
    if (layer.invalidFiles.length > 0 && !readonlyActions.has(input.action))
      return {
        decision: "ask",
        ruleIDs: ["configuration.invalid"],
        reason: `Invalid guardrail configuration: ${layer.invalidFiles.join(", ")}`,
        standard: false,
      }
    if (match)
      return {
        decision: match.decision,
        ruleIDs: [match.id],
        reason: match.reason,
        standard: false,
      }
  }

  const standardAsk = standard.find((item) => item.decision === "ask")
  if (standardAsk)
    return { decision: "ask", ruleIDs: [standardAsk.id], reason: standardAsk.reason, standard: true }

  return { decision: "allow", ruleIDs: [], standard: false }
}
