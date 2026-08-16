export * as ConfigImageAnalyzer from "./image-analyzer"

import { Schema } from "effect"
import { ConfigModel } from "./model"
import { PositiveInt } from "../schema"

export class Info extends Schema.Class<Info>("ConfigV2.ImageAnalyzer")({
  enabled: Schema.Boolean.pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional),
  provider: Schema.String.pipe(Schema.optional),
  variant: Schema.String.pipe(Schema.optional),
  prompt: Schema.String.pipe(Schema.optional),
  template: Schema.String.pipe(Schema.optional),
  max_images: PositiveInt.pipe(Schema.optional),
  max_bytes: PositiveInt.pipe(Schema.optional),
}) {}

export const resolveSelection = (info: Info): ConfigModel.Selection | undefined => {
  const model = info.model
  if (model !== undefined) {
    if (model.includes("/")) {
      try {
        return Schema.decodeUnknownSync(ConfigModel.Selection)(model)
      } catch {
        return undefined
      }
    }
    if (info.provider) {
      const selector = `${info.provider}/${model}${info.variant && !model.includes("#") ? `#${info.variant}` : ""}`
      try {
        return Schema.decodeUnknownSync(ConfigModel.Selection)(selector)
      } catch {
        return undefined
      }
    }
  }
  if (info.provider && model && !model.includes("/")) {
    const selector = `${info.provider}/${model}${info.variant ? `#${info.variant}` : ""}`
    try {
      return Schema.decodeUnknownSync(ConfigModel.Selection)(selector)
    } catch {
      return undefined
    }
  }
  return undefined
}

export const isEnabled = (info: Info | undefined): boolean => {
  if (!info) return false
  if (info.enabled === false) return false
  // Enabled requires a resolvable model
  return resolveSelection(info) !== undefined
}

export const effectivePrompt = (info: Info | undefined): string | undefined => info?.prompt ?? info?.template
