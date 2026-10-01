export * as CursorModels from "./models"

import { Money } from "@ycoding-ai/schema/money"
import type { ModelInfo, ModelParameterValue, ModelVariant } from "./provider/models"
import { getCursorModelCost, hasCursorFastPricing } from "./provider/pricing"
import { ModelV2 } from "../model"
import { ProviderV2 } from "../provider"

export const providerID = ProviderV2.ID.make("cursor")
export const packageName = "cursor-opencode-provider"
export const variantParametersKey = "cursorVariantParameters"

type Tier = "base" | "long"
type Group = { tier: Tier; fast: boolean; variants: ModelVariant[]; suffix: string }

export function fromCursor(models: readonly ModelInfo[]): ModelV2.Info[] {
  const ambiguous = thinkingSuffixNames(models)
  const used = new Set(models.map((model) => model.id))
  return models.flatMap((model) => {
    const thinking = !!model.supportsThinking && ambiguous.has(label(model.displayName ?? model.id))
    const groups = tierGroups(model)
    if (groups.length === 0)
      return [info(model, ModelV2.ID.make(model.id), { tier: "base", fast: false, variants: [], suffix: "" }, thinking)]
    const primary = Math.max(
      groups.findIndex((group) => group.suffix === ""),
      0,
    )
    return groups.map((group, index) =>
      info(model, ModelV2.ID.make(index === primary ? model.id : uniqueID(used, model.id, group.suffix)), group, thinking),
    )
  })
}

function info(model: ModelInfo, id: ModelV2.ID, group: Group, thinking: boolean): ModelV2.Info {
  const images = model.supportsImages ?? false
  const defaults = id === model.id && group.tier === "base" && !group.fast ? undefined : defaultVariant(group)
  return ModelV2.Info.make({
    ...ModelV2.Info.empty(providerID, id),
    modelID: ModelV2.ID.make(model.id),
    ...(model.family ? { family: ModelV2.Family.make(model.family) } : {}),
    name: [
      label(model.displayName ?? model.id),
      ...(thinking ? ["Thinking"] : []),
      ...(group.fast ? ["Fast"] : []),
      ...(group.tier === "long" ? ["1M"] : []),
    ].join(" "),
    package: ProviderV2.aisdk(packageName),
    ...(defaults ? { settings: { [variantParametersKey]: parameters(defaults.parameterValues) } } : {}),
    capabilities: {
      tools: model.supportsAgent ?? true,
      input: images ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: variants(model, group.variants),
    cost: costs(
      getCursorModelCost(group.fast ? `${model.id}-fast` : group.tier === "long" ? `${model.id}-1m` : model.id),
    ),
    limit:
      group.tier === "long"
        ? { context: model.maxContextForMaxMode ?? 1_000_000, output: 128_000 }
        : { context: model.maxContext ?? (model.id === "default" ? 256_000 : 200_000), output: 32_000 },
  })
}

function costs(cost: ReturnType<typeof getCursorModelCost>): ModelV2.Info["cost"] {
  if (!cost) return []
  const row = (rate: NonNullable<typeof cost>) => ({
    input: Money.USDPerMillionTokens.make(rate.input),
    output: Money.USDPerMillionTokens.make(rate.output),
    cache: {
      read: Money.USDPerMillionTokens.make(rate.cache_read ?? 0),
      write: Money.USDPerMillionTokens.make(rate.cache_write ?? 0),
    },
  })
  return [
    row(cost),
    ...(cost.context_over_200k
      ? [{ tier: { type: "context" as const, size: 200_000 }, ...row(cost.context_over_200k) }]
      : []),
  ]
}

function tierGroups(model: ModelInfo): Group[] {
  const splitFast = hasCursorFastPricing(model.id)
  return (["base", "long"] as const).flatMap((tier) => {
    const tiered = model.variants.filter((variant) => isLongContext(variant) === (tier === "long"))
    const speeds = splitFast
      ? [
          { fast: false, variants: tiered.filter((variant) => !isFast(variant)) },
          { fast: true, variants: tiered.filter(isFast) },
        ]
      : [{ fast: false, variants: tiered }]
    return speeds
      .filter((speed) => speed.variants.length > 0)
      .map((speed) => ({ tier, ...speed, suffix: `${tier === "long" ? "-1m" : ""}${speed.fast ? "-fast" : ""}` }))
  })
}

function defaultVariant(group: Group) {
  return (
    group.variants.find((variant) => (group.tier === "long" ? variant.isDefaultMax : variant.isDefaultNonMax)) ??
    group.variants[0]
  )
}

function variants(model: ModelInfo, input: readonly ModelVariant[]): ModelV2.Info["variants"] {
  const base = label(model.displayName ?? model.id)
  const used = new Set<string>()
  return input.map((variant) => {
    const sanitized = label(variant.displayName || variant.key || "default")
    const tagged = `${sanitized}${dimensions(variant.parameterValues)}`
    const first = sanitized === base && !used.has(sanitized) ? `${base}${dimensions(variant.parameterValues)}` : undefined
    const candidate = first ?? (used.has(sanitized) ? tagged : sanitized)
    const id = used.has(candidate)
      ? (Array.from({ length: used.size + 1 }, (_, index) => `${tagged} ${index + 2}`).find((item) => !used.has(item)) ??
        tagged)
      : candidate
    used.add(id)
    return {
      id: ModelV2.VariantID.make(id),
      settings: { [variantParametersKey]: parameters(variant.parameterValues) },
    }
  })
}

function dimensions(values: readonly ModelParameterValue[]) {
  const labels = values.flatMap((value) => {
    if (value.id === "fast" && value.value === "true") return ["Fast"]
    if (value.id === "thinking" && value.value === "true") return ["Thinking"]
    if (value.id === "context") return [value.value]
    return []
  })
  if (labels.length > 0) return ` ${labels.join(" ")}`
  if (values.length === 0) return ""
  return " default"
}

function parameters(values: readonly ModelParameterValue[]) {
  return values.map((value) => ({ id: value.id, value: value.value }))
}

function thinkingSuffixNames(models: readonly ModelInfo[]) {
  const groups = Map.groupBy(models, (model) => label(model.displayName ?? model.id))
  return new Set(
    [...groups].flatMap(([name, group]) =>
      group.some((model) => model.supportsThinking) && group.some((model) => !model.supportsThinking) ? [name] : [],
    ),
  )
}

function uniqueID(used: Set<string>, modelID: string, suffix: string) {
  const candidates = [
    `${modelID}${suffix}`,
    ...Array.from({ length: used.size + 1 }, (_, index) => {
      const n = index + 2
      if (suffix === "-fast") return `${modelID}-fast-${n}`
      if (suffix === "-1m-fast") return `${modelID}-1m-${n}-fast`
      return `${modelID}-1m-${n}`
    }),
  ]
  const id = candidates.find((candidate) => !used.has(candidate)) ?? `${modelID}${suffix}`
  used.add(id)
  return id
}

function label(value: string) {
  return (
    value
      .replace(/<[^>]*>/g, "")
      .replace(/[()<>&"'`]/g, "")
      .replace(/\s+/g, " ")
      .trim() || "default"
  )
}

function isLongContext(variant: ModelVariant) {
  return variant.parameterValues.some((value) => value.id === "context" && contextTokens(value.value) === 1_000_000)
}

function isFast(variant: ModelVariant) {
  return variant.parameterValues.some((value) => value.id === "fast" && value.value === "true")
}

function contextTokens(value: string) {
  const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(value.trim())
  if (match) return Number(match[1]) * (match[2].toLowerCase() === "k" ? 1_000 : 1_000_000)
  return Number(value.trim())
}
