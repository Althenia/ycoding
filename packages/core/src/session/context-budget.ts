export * as SessionContextBudget from "./context-budget"

import type { ModelV2 } from "../model"
import type { ProviderV2 } from "../provider"
import { Token } from "../util/token"

export type Capabilities = {
  readonly contextWindowTokens: number
  readonly maxOutputTokens: number
  readonly contextSafetyMarginTokens: number
}

export type Pressure = "normal" | "informational" | "advisory" | "high" | "critical" | "terminal"

export type PressureThresholds = {
  readonly informational: number
  readonly advisory: number
  readonly high: number
  readonly critical: number
  readonly terminal: number
}

const DEFAULT_SAFETY_MARGIN_TOKENS = 0
const DEFAULT_PRESSURE_THRESHOLDS = {
  informational: 0.25,
  advisory: 0.5,
  high: 0.75,
  critical: 0.9,
  terminal: 1,
} satisfies PressureThresholds

// The registry supplies real context/output limits per model; the safety margin is a caller
// reservation on top of the reserved output, defaulting to zero extra.
export const resolveCapabilities = (
  models: readonly ModelV2.Info[],
  providerID: ProviderV2.ID,
  modelID: ModelV2.ID,
  options?: { readonly safetyMarginTokens?: number },
): Capabilities | undefined => {
  const model = models.find((item) => item.providerID === providerID && item.id === modelID)
  if (!model) return
  return {
    contextWindowTokens: model.limit.context,
    maxOutputTokens: model.limit.output,
    contextSafetyMarginTokens: options?.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS,
  }
}

export const safeInputBudget = (
  capabilities: Capabilities,
  reservedOutputTokens = capabilities.maxOutputTokens,
) => capabilities.contextWindowTokens - reservedOutputTokens - capabilities.contextSafetyMarginTokens

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

export const classifyPressure = (
  usedTokens: number,
  safeTokens: number,
  thresholds: PressureThresholds = DEFAULT_PRESSURE_THRESHOLDS,
): Pressure => {
  if (safeTokens <= 0) return "terminal"
  const ratio = usedTokens / safeTokens
  if (ratio >= thresholds.terminal) return "terminal"
  if (ratio >= thresholds.critical) return "critical"
  if (ratio >= thresholds.high) return "high"
  if (ratio >= thresholds.advisory) return "advisory"
  if (ratio >= thresholds.informational) return "informational"
  return "normal"
}

export const changed = (previous: Pressure, next: Pressure) => previous !== next
