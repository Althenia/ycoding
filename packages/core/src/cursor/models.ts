export * as CursorModels from "./models"

import { Money } from "@ycoding-ai/schema/money"
import type { ModelInfo, ModelParameterValue, ModelVariant } from "./provider/models"
import { getCursorModelCost } from "./provider/pricing"
import { CatalogModel } from "../model"
import { Provider } from "../provider"

export const providerID = Provider.ID.make("cursor")
export const packageName = "cursor-opencode-provider"
export const variantParametersKey = "cursorVariantParameters"

type Group = { context?: number; fast: boolean; variants: ModelVariant[]; suffix: string }

export function fromCursor(models: readonly ModelInfo[]): CatalogModel.Info[] {
  const ambiguous = thinkingSuffixNames(models)
  const used = new Set(models.map((model) => model.id))
  return models.flatMap((model) => {
    const thinking = !!model.supportsThinking && ambiguous.has(label(model.displayName ?? model.id))
    const groups = tierGroups(model)
    if (groups.length === 0)
      return [info(model, CatalogModel.ID.make(model.id), { fast: false, variants: [], suffix: "" }, thinking)]
    const primary = Math.max(
      groups.findIndex((group) => group.suffix === ""),
      0,
    )
    return groups.map((group, index) =>
      info(model, CatalogModel.ID.make(index === primary ? model.id : uniqueID(used, model.id, group.suffix)), group, thinking),
    )
  })
}

function info(model: ModelInfo, id: CatalogModel.ID, group: Group, thinking: boolean): CatalogModel.Info {
  const images = model.supportsImages ?? false
  const offeredVariants = variants(model, group.variants)
  const defaults = id === model.id && group.context === undefined && !group.fast && offeredVariants.length > 0
    ? undefined : defaultVariant(group)
  return CatalogModel.Info.make({
    ...CatalogModel.Info.empty(providerID, id),
    modelID: CatalogModel.ID.make(model.id),
    ...(model.family ? { family: CatalogModel.Family.make(model.family) } : {}),
    name: [
      label(model.displayName ?? model.id),
      ...(thinking ? ["Thinking"] : []),
      ...(group.fast ? ["Fast"] : []),
      ...(group.context === undefined ? [] : [contextLabel(group.context)]),
    ].join(" "),
    package: Provider.aisdk(packageName),
    ...(defaults ? { settings: { [variantParametersKey]: parameters(defaults.parameterValues) } } : {}),
    capabilities: {
      tools: model.supportsAgent ?? true,
      input: images ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    variants: offeredVariants,
    cost: costs(
      getCursorModelCost(group.fast ? `${model.id}-fast` : group.context === 1_000_000 ? `${model.id}-1m` : model.id),
    ),
    limit: {
      context: group.context ?? model.maxContext ?? (model.id === "default" ? 256_000 : 200_000),
      output: group.context === 1_000_000 ? 128_000 : 32_000,
    },
  })
}

function costs(cost: ReturnType<typeof getCursorModelCost>): CatalogModel.Info["cost"] {
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
  const splitFast = model.variants.some(isFast)
  const baseContext = model.maxContext ?? (model.id === "default" ? 256_000 : 200_000)
  const contexts = [...new Set(model.variants.flatMap((variant) => {
    const context = variantContext(variant, baseContext)
    return context === undefined ? [] : [context]
  }))]
  return ([undefined, ...contexts] as const).flatMap((context) => {
    const tiered = model.variants.filter((variant) => variantContext(variant, baseContext) === context)
    const speeds = splitFast
      ? [
          { fast: false, variants: tiered.filter((variant) => !isFast(variant)) },
          { fast: true, variants: tiered.filter(isFast) },
        ]
      : [{ fast: false, variants: tiered }]
    return speeds
      .filter((speed) => speed.variants.length > 0)
      .map((speed) => ({ context, ...speed, suffix: `${context === undefined ? "" : `-${contextLabel(context).toLowerCase()}`}${speed.fast ? "-fast" : ""}` }))
  })
}

function defaultVariant(group: Group) {
  return (
    group.variants.find((variant) => (group.context === undefined ? variant.isDefaultNonMax : variant.isDefaultMax)) ??
    group.variants[0]
  )
}

function variants(model: ModelInfo, input: readonly ModelVariant[]): CatalogModel.Info["variants"] {
  if (input.length === 1 && !input[0]?.parameterValues.some((value) => value.id === "effort")) return []
  const base = label(model.displayName ?? model.id)
  const used = new Set<string>()
  return input.map((variant) => {
    const effort = variant.parameterValues.find((value) => value.id === "effort")?.value
    const sanitized = label(variant.displayName || variant.key || "default")
    const tagged = `${sanitized}${dimensions(variant.parameterValues)}`
    const first = sanitized === base && !used.has(sanitized) ? `${base}${dimensions(variant.parameterValues)}` : undefined
    const candidate = effort && ["low", "medium", "high", "xhigh"].includes(effort)
      ? effort : first ?? (used.has(sanitized) ? tagged : sanitized)
    const id = used.has(candidate)
      ? (Array.from({ length: used.size + 1 }, (_, index) => `${tagged} ${index + 2}`).find((item) => !used.has(item)) ??
        tagged)
      : candidate
    used.add(id)
    return {
      id: CatalogModel.VariantID.make(id),
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
      if (suffix.endsWith("-fast")) return `${modelID}${suffix.slice(0, -5)}-${n}-fast`
      return `${modelID}${suffix}-${n}`
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

function isFast(variant: ModelVariant) {
  return variant.parameterValues.some((value) => value.id === "fast" && value.value === "true")
}

function contextTokens(value: string) {
  const match = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(value.trim())
  const tokens = match ? Number(match[1]) * (match[2].toLowerCase() === "k" ? 1_000 : 1_000_000) : Number(value.trim())
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined
}

function variantContext(variant: ModelVariant, baseContext: number) {
  const value = variant.parameterValues.find((parameter) => parameter.id === "context")?.value
  const context = value === undefined ? undefined : contextTokens(value)
  return context === baseContext ? undefined : context
}

function contextLabel(tokens: number) {
  return tokens % 1_000_000 === 0 ? `${tokens / 1_000_000}M` : tokens % 1_000 === 0 ? `${tokens / 1_000}k` : String(tokens)
}
