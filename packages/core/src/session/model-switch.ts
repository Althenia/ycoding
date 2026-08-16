export * as SessionModelSwitch from "./model-switch"

import { Session } from "@ycoding-ai/schema/session"
import { ModelV2 } from "../model"
import { SessionContextBudget } from "./context-budget"
import { SessionMessage } from "./message"
import { toLLMMessages } from "./runner/to-llm-message"

export type Blocked = Session.ModelSwitchBlocked

export type Outcome = { readonly status: "switched" } | Blocked

/**
 * Estimates the model-visible summary and recent transcript size with the same
 * canonical message lowering the request builder uses and the same estimate
 * token metric as the compaction planner. The estimate covers the summary and
 * recent messages only; system, tool, and attachment prefixes are not included.
 */
export const estimateContextTokens = (messages: readonly SessionMessage.Info[], model: ModelV2.Ref) =>
  SessionContextBudget.countTokens(
    JSON.stringify(
      toLLMMessages(
        messages.map((message) => (message.type === "user" ? { ...message, files: undefined } : message)),
        model,
      ),
    ),
  )

/**
 * Decides whether the current context fits the target model. An absent current
 * model or unresolvable target capabilities cannot be validated, so the switch
 * proceeds exactly as before; the runner remains the authority on model
 * availability. A blocked outcome never triggers summarization: its optional
 * boundary is advisory only.
 */
export const decide = (input: {
  readonly currentModel?: ModelV2.Ref
  readonly targetModel: ModelV2.Ref
  readonly messages: readonly SessionMessage.Info[]
  readonly model: ModelV2.Ref
  readonly target?: SessionContextBudget.Capabilities
}): Outcome => {
  if (input.currentModel === undefined || input.target === undefined) return { status: "switched" }
  const targetSafeInputTokens = Math.max(0, SessionContextBudget.safeInputBudget(input.target))
  const currentContextTokens = estimateContextTokens(input.messages, input.model)
  if (currentContextTokens <= targetSafeInputTokens) return { status: "switched" }
  return {
    status: "blocked",
    currentModel: input.currentModel,
    targetModel: input.targetModel,
    currentContextTokens,
    targetSafeInputTokens,
    requiredReductionTokens: currentContextTokens - targetSafeInputTokens,
    reason: "context-window-exceeded",
  }
}
