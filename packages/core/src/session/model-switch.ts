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
  SessionContextBudget.countTokens(JSON.stringify(toLLMMessages(messages, model)))

/**
 * Advisory boundary for a blocked switch: summarizing up to and including the
 * returned message ID, while keeping `keepRecentMessages` messages after it,
 * is estimated to fit the target safe input budget. Undefined when there is
 * no older messages outside the kept window, or the kept window alone already
 * exceeds the budget. The replacement summary is not estimated because it is
 * generated later; this boundary is advisory and never starts compaction.
 */
const summarizeBoundary = (input: {
  readonly messages: readonly SessionMessage.Info[]
  readonly model: ModelV2.Ref
  readonly targetSafeInputTokens: number
  readonly keepRecentMessages?: number
}): SessionMessage.ID | undefined => {
  if (input.keepRecentMessages === undefined) return
  const compactionIndex = input.messages.findIndex(
    (message) => message.type === "compaction" && message.status === "completed",
  )
  if (compactionIndex === -1) return
  const post = input.messages.slice(compactionIndex + 1)
  const keep = input.keepRecentMessages
  const keptStart = Math.max(0, post.length - keep)
  if (keptStart === 0) return
  const kept = post.slice(keptStart)
  if (estimateContextTokens(kept, input.model) > input.targetSafeInputTokens) return
  return post[keptStart - 1]?.id
}

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
  readonly keepRecentMessages?: number
}): Outcome => {
  if (input.currentModel === undefined || input.target === undefined) return { status: "switched" }
  const targetSafeInputTokens = Math.max(0, SessionContextBudget.safeInputBudget(input.target))
  const currentContextTokens = estimateContextTokens(input.messages, input.model)
  if (currentContextTokens <= targetSafeInputTokens) return { status: "switched" }
  const boundary = summarizeBoundary({
    messages: input.messages,
    model: input.model,
    targetSafeInputTokens,
    keepRecentMessages: input.keepRecentMessages,
  })
  return {
    status: "blocked",
    currentModel: input.currentModel,
    targetModel: input.targetModel,
    currentContextTokens,
    targetSafeInputTokens,
    requiredReductionTokens: currentContextTokens - targetSafeInputTokens,
    ...(boundary === undefined ? {} : { maximumSafeSummaryBoundary: boundary }),
    reason: "context-window-exceeded",
  }
}
