export * as SessionContextBudget from "./context-budget"

import type { ModelV2 } from "../model"
import type { ProviderV2 } from "../provider"
import { ConfigCompaction } from "../config/compaction"
import { Token } from "../util/token"

export type Capabilities = {
  readonly contextWindowTokens: number
  readonly maxOutputTokens: number
  readonly contextSafetyMarginTokens: number
}

// The registry supplies the real context limit per model; the safety margin is a
// caller reservation. Output limits are intentionally excluded: advisory gates
// measure against the raw context window and the hard cap is context - margin.
export const resolveCapabilities = (
  models: readonly ModelV2.Info[],
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  options?: { readonly safetyMarginTokens?: number },
): Capabilities | undefined => {
  const model = models.find((item) => item.providerID === providerID && item.id === modelID)
  if (!model) return undefined
  return {
    contextWindowTokens: model.limit.context,
    maxOutputTokens: model.limit.output,
    contextSafetyMarginTokens: options?.safetyMarginTokens ?? ConfigCompaction.resolve([]).contextSafetyMarginTokens,
  }
}

export const safeInputBudget = (capabilities: Capabilities) =>
  capabilities.contextWindowTokens - capabilities.contextSafetyMarginTokens

export type InputTokenComponents = {
  readonly systemInstructions?: number
  readonly toolDefinitions?: number
  readonly workspaceInstructions?: number
  readonly rollingSummary?: number
  readonly recentMessages?: number
  readonly attachments?: number
  readonly retrievedContext?: number
  readonly providerOverhead?: number
}

export const sumInputTokens = (input: InputTokenComponents) =>
  (input.systemInstructions ?? 0) +
  (input.toolDefinitions ?? 0) +
  (input.workspaceInstructions ?? 0) +
  (input.rollingSummary ?? 0) +
  (input.recentMessages ?? 0) +
  (input.attachments ?? 0) +
  (input.retrievedContext ?? 0) +
  (input.providerOverhead ?? 0)

// Token.estimate divides characters by four: it is an estimate, never an exact token count.
export const countTokens = (text: string) => Token.estimate(text)
