export * as SessionGuardrailMatch from "./guardrail-match"

import type { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Wildcard } from "../util/wildcard"
import { SessionGuardrailStandard } from "./guardrail-standard"

export interface Input {
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly paths?: SessionGuardrailStandard.Paths
  /** Custom source layers ordered from nearest repository scope to user scope. */
  readonly custom?: ReadonlyArray<CustomLayer>
}

export interface CustomLayer {
  readonly rules: Guardrail.Ruleset
  readonly invalidFiles: ReadonlyArray<string>
}

export interface Result {
  readonly decision: "allow" | "ask" | "deny"
  readonly ruleIDs: ReadonlyArray<string>
  readonly reason?: string
  readonly standard: boolean
  readonly hardReview: boolean
}

const readonlyActions = new Set(["read", "glob", "grep", "webfetch", "websearch"])

export function evaluate(input: Input): Result {
  const standard = input.resources.flatMap((resource) => {
    const match = SessionGuardrailStandard.match(input.action, resource, input.paths)
    return match ? [match] : []
  })
  const standardDeny = standard.find((item) => item.decision === "deny")
  if (standardDeny)
    return {
      decision: "deny",
      ruleIDs: [standardDeny.id],
      reason: standardDeny.reason,
      standard: true,
      hardReview: false,
    }

  const customHardReview = (input.custom ?? []).flatMap((layer) =>
    matchingRules(input, layer).filter((rule) => rule.decision === "hard_review"),
  )[0]
  const custom = customResult(input)
  if (custom?.decision === "deny") return custom

  const standardHardReview = standard.find((item) => item.hardReview)
  if (standardHardReview)
    return {
      decision: "ask",
      ruleIDs: [standardHardReview.id],
      reason: standardHardReview.reason,
      standard: true,
      hardReview: true,
    }
  if (customHardReview)
    return {
      decision: "ask",
      ruleIDs: [customHardReview.id],
      reason: customHardReview.reason,
      standard: false,
      hardReview: true,
    }
  if (custom) return custom

  const standardAsk = standard.find((item) => item.decision === "ask")
  if (standardAsk)
    return {
      decision: "ask",
      ruleIDs: [standardAsk.id],
      reason: standardAsk.reason,
      standard: true,
      hardReview: false,
    }

  return { decision: "allow", ruleIDs: [], standard: false, hardReview: false }
}

function customResult(input: Input): Result | undefined {
  for (const layer of input.custom ?? []) {
    const match = matchingRules(input, layer)[0]
    if (match?.decision === "deny")
      return {
        decision: match.decision,
        ruleIDs: [match.id],
        reason: match.reason,
        standard: false,
        hardReview: false,
      }
    if (layer.invalidFiles.length > 0 && !readonlyActions.has(input.action))
      return {
        decision: "ask",
        ruleIDs: ["configuration.invalid"],
        reason: `Invalid guardrail configuration: ${layer.invalidFiles.join(", ")}`,
        standard: false,
        hardReview: false,
      }
    if (match)
      return {
        decision: match.decision === "hard_review" ? "ask" : match.decision,
        ruleIDs: [match.id],
        reason: match.reason,
        standard: false,
        hardReview: match.decision === "hard_review",
      }
  }
  return undefined
}

function matchingRules(input: Input, layer: CustomLayer) {
  return layer.rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) =>
      input.resources.some(
        (resource) =>
          rule.actions.some((action) => Wildcard.match(input.action, action)) &&
          rule.resources.some((pattern) => Wildcard.match(resource, pattern)),
      ),
    )
    .toSorted((left, right) => right.rule.priority - left.rule.priority || left.index - right.index)
    .map(({ rule }) => rule)
}
