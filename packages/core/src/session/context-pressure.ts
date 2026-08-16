export * as SessionContextPressure from "./context-pressure"

import type { LLMRequest } from "@ycoding-ai/ai"
import { Config } from "../config"
import { ConfigCompaction } from "../config/compaction"
import type { ModelV2 } from "../model"
import { SessionContextBudget } from "./context-budget"

export const policy = (entries: readonly Config.Entry[]) =>
  ConfigCompaction.resolve(
    entries
      .filter((entry): entry is Config.Document => entry.type === "document")
      .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : [])),
  )

export const contextSafetyMarginTokens = (entries: readonly Config.Entry[]) => policy(entries).contextSafetyMarginTokens

/** Context pressure uses resolved advisory thresholds and becomes mandatory at the hard input cap. */
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
    recentMessages: SessionContextBudget.countTokens(
      JSON.stringify(
        input.messages.map((message) => ({
          ...message,
          content:
            typeof message.content === "string"
              ? message.content
              : message.content.map((part) => (part.type === "media" ? { ...part, data: "" } : part)),
        })),
      ),
    ),
  })

export const level = (
  input: Usage & {
    readonly capabilities: SessionContextBudget.Capabilities
    readonly policy?: ConfigCompaction.Resolved
  },
): Level => {
  const hardInputCap = hardInputCapTokens(input.capabilities)
  if (hardInputCap <= 0) return "mandatory"
  const estimate = estimatedInputTokens(input)
  if (estimate >= hardInputCap) return "mandatory"
  const resolved = input.policy ?? ConfigCompaction.resolve([])
  if (resolved.advisory === false) return "normal"
  if (estimate * 100 >= hardInputCap * resolved.advisory.stronglyAdvisedPercent) return "advised"
  if (estimate * 100 >= hardInputCap * resolved.advisory.considerPercent) return "consider"
  return "normal"
}

export const modelLevel = (
  input: Usage & {
    readonly models: readonly ModelV2.Info[]
    readonly model: ModelV2.Ref
    readonly policy: ConfigCompaction.Resolved
  },
) => {
  const capabilities = SessionContextBudget.resolveCapabilities(input.models, input.model.providerID, input.model.id, {
    safetyMarginTokens: input.policy.contextSafetyMarginTokens,
  })
  if (!capabilities) return undefined
  return level({ ...input, capabilities })
}
