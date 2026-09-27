export * as SessionContextPressure from "./context-pressure"

import type { LLMRequest } from "@ycoding-ai/ai"
import { Config } from "../config"
import { ConfigCompaction } from "../config/compaction"
import type { ModelV2 } from "../model"
import { Token } from "../util/token"
import { SessionContextBudget } from "./context-budget"

export const policy = (entries: readonly Config.Entry[]) =>
  ConfigCompaction.resolve(
    entries
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : [])),
  )

export const contextSafetyMarginTokens = (entries: readonly Config.Entry[]) => policy(entries).contextSafetyMarginTokens

/** Context pressure uses resolved advisory thresholds against the raw context
 * window and becomes mandatory at the hard input cap (context - safety margin).
 * maxOutputTokens is retained on capabilities for compatibility but ignored. */
export type Level = "normal" | "consider" | "advised" | "mandatory"

export type Usage = {
  readonly system: LLMRequest["system"]
  readonly tools: LLMRequest["tools"]
  readonly messages: LLMRequest["messages"]
}

export const hardInputCapTokens = (capabilities: SessionContextBudget.Capabilities) =>
  SessionContextBudget.safeInputBudget(capabilities)

export const estimatedInputTokens = (input: Usage) =>
  SessionContextBudget.sumInputTokens({
    systemInstructions: SessionContextBudget.countTokens(input.system.map((part) => part.text).join("\n")),
    toolDefinitions: SessionContextBudget.countTokens(JSON.stringify(input.tools)),
    recentMessages: Token.estimateJson(input.messages),
  })

export const breakdown = (input: Usage) => {
  const totals = {
    system: SessionContextBudget.countTokens(input.system.map((part) => part.text).join("\n")),
    tools: input.tools.length ? SessionContextBudget.countTokens(JSON.stringify(input.tools)) : 0,
    user: 0,
    assistant: 0,
    reasoning: 0,
    toolCalls: 0,
    other: 0,
  }
  for (const message of input.messages) {
    for (const part of message.content) {
      const category =
        part.type === "tool-call" || part.type === "tool-result" || message.role === "tool"
          ? "toolCalls"
          : part.type === "reasoning"
            ? "reasoning"
            : part.type !== "text"
              ? "other"
              : message.role === "user" || message.role === "assistant" || message.role === "system"
                ? message.role
                : "other"
      totals[category] += Token.estimateJson(part)
    }
  }
  return totals
}

export const level = (
  input: Usage & {
    readonly capabilities: SessionContextBudget.Capabilities
    readonly policy?: ConfigCompaction.Resolved
    readonly estimate?: number
  },
): Level => {
  const hardInputCap = hardInputCapTokens(input.capabilities)
  if (hardInputCap <= 0) return "mandatory"
  const estimate = input.estimate ?? estimatedInputTokens(input)
  if (estimate >= hardInputCap) return "mandatory"
  const resolved = input.policy ?? ConfigCompaction.resolve([])
  if (resolved.advisory === false) return "normal"
  const contextWindowTokens = input.capabilities.contextWindowTokens
  if (estimate * 100 >= contextWindowTokens * resolved.advisory.stronglyAdvisedPercent) return "advised"
  if (estimate * 100 >= contextWindowTokens * resolved.advisory.considerPercent) return "consider"
  return "normal"
}

export const modelLevel = (
  input: Usage & {
    readonly models: readonly ModelV2.Info[]
    readonly model: ModelV2.Ref
    readonly policy: ConfigCompaction.Resolved
    readonly estimate?: number
  },
) => {
  const capabilities = SessionContextBudget.resolveCapabilities(input.models, input.model.providerID, input.model.id, {
    safetyMarginTokens: input.policy.contextSafetyMarginTokens,
  })
  if (!capabilities) return undefined
  return level({ ...input, capabilities })
}
