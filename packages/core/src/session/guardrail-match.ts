export * as SessionGuardrailMatch from "./guardrail-match"

import type { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Wildcard } from "../util/wildcard"
import { SessionGuardrailStandard } from "./guardrail-standard"

export interface Input {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly custom?: Guardrail.Ruleset
  readonly invalidFiles?: ReadonlyArray<string>
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

  const custom = (input.custom ?? [])
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) =>
      input.resources.some(
        (resource) =>
          rule.actions.some((action) => Wildcard.match(input.action, action)) &&
          rule.resources.some((pattern) => Wildcard.match(resource, pattern)),
      ),
    )
    .toSorted((left, right) => right.rule.priority - left.rule.priority || left.index - right.index)

  const customDeny = custom.find(({ rule }) => rule.decision === "deny")?.rule
  if (customDeny)
    return {
      decision: "deny",
      ruleIDs: [customDeny.id],
      reason: customDeny.reason,
      standard: false,
    }

  const standardAsk = standard.find((item) => item.decision === "ask")
  if (standardAsk)
    return { decision: "ask", ruleIDs: [standardAsk.id], reason: standardAsk.reason, standard: true }

  if ((input.invalidFiles?.length ?? 0) > 0 && !readonlyActions.has(input.action))
    return {
      decision: "ask",
      ruleIDs: ["configuration.invalid"],
      reason: `Invalid guardrail configuration: ${input.invalidFiles?.join(", ")}`,
      standard: true,
    }

  const customAsk = custom.find(({ rule }) => rule.decision === "ask")?.rule
  if (customAsk)
    return {
      decision: "ask",
      ruleIDs: [customAsk.id],
      reason: customAsk.reason,
      standard: false,
    }

  const customAllow = custom.find(({ rule }) => rule.decision === "allow")?.rule
  if (customAllow)
    return {
      decision: "allow",
      ruleIDs: [customAllow.id],
      reason: customAllow.reason,
      standard: false,
    }

  return { decision: "allow", ruleIDs: [], standard: false }
}
