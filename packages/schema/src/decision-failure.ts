export * as DecisionFailure from "./decision-failure.js"

import { Schema } from "effect"

export const Reason = Schema.Literals([
  "unavailable",
  "invalid-request",
  "provider-failed",
  "timeout",
  "input-too-large",
  "invalid-output",
  "refused",
  "truncated-output",
  "unsupported-output",
]).annotate({ identifier: "DecisionFailure.Reason" })
export type Reason = typeof Reason.Type

const descriptions = {
  unavailable: "the decision model or its authenticated route is unavailable",
  "invalid-request": "the decision request is invalid",
  "provider-failed": "the provider request failed",
  timeout: "the decision request timed out",
  "input-too-large": "the decision input exceeds the supported size",
  "invalid-output": "the decision response failed validation",
  refused: "the provider or model refused the decision request",
  "truncated-output": "the decision response was truncated or did not finish",
  "unsupported-output": "the selected route does not support strict structured decisions",
} satisfies Record<Reason, string>

export function describe(reason: Reason) {
  return descriptions[reason]
}
