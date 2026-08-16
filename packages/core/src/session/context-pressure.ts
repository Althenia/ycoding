export * as SessionContextPressure from "./context-pressure"

import { Message, type LLMRequest } from "@ycoding-ai/ai"
import type { Config } from "../config"
import type { ModelV2 } from "../model"
import { SessionContextBudget } from "./context-budget"

export const contextSafetyMarginTokens = (entries: readonly Config.Entry[]) =>
  entries
    .filter((entry): entry is Config.Document => entry.type === "document")
    .reduce(
      (margin, entry) => entry.info.compaction?.context_safety_margin_tokens ?? margin,
      0,
    )

export const advisory = (input: {
  readonly models: readonly ModelV2.Info[]
  readonly model: ModelV2.Ref
  readonly contextSafetyMarginTokens: number
  readonly system: LLMRequest["system"]
  readonly tools: LLMRequest["tools"]
  readonly messages: LLMRequest["messages"]
}) => {
  const capabilities = SessionContextBudget.resolveCapabilities(input.models, input.model.providerID, input.model.id, {
    safetyMarginTokens: input.contextSafetyMarginTokens,
  })
  if (!capabilities) return
  const usedTokens = SessionContextBudget.sumInputTokens({
    systemInstructions: SessionContextBudget.countTokens(input.system.map((part) => part.text).join("\n")),
    toolDefinitions: SessionContextBudget.countTokens(JSON.stringify(input.tools)),
    recentMessages: SessionContextBudget.countTokens(JSON.stringify(input.messages)),
  })
  const pressure = SessionContextBudget.classifyPressure(
    usedTokens,
    SessionContextBudget.safeInputBudget(capabilities),
  )
  if (pressure === "normal") return
  return Message.make({
    role: "user",
    content: advisoryText(pressure),
    volatile: true,
  })
}

function advisoryText(pressure: Exclude<SessionContextBudget.Pressure, "normal">) {
  if (pressure === "informational")
    return "Context is starting to fill; a completed phase could be summarized with conversation_summarize when one finishes."
  if (pressure === "advisory")
    return "This is a good moment to summarize the earliest completed phase with conversation_summarize, if one exists."
  if (pressure === "high")
    return "Summarizing completed history soon with conversation_summarize is recommended to keep working context compact and meaningful."
  if (pressure === "critical")
    return "Context is nearly exhausted; summarizing a completed boundary with conversation_summarize is strongly advised."
  return "Safe input budget is exhausted; summarizing a completed boundary with conversation_summarize is required to continue reliably, and no automatic compaction will do it for you."
}
