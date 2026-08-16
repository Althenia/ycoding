export * as ImageAnalyzer from "./image-analyzer"

import { LLM, Message } from "@ycoding-ai/ai"
import { LLMClient } from "@ycoding-ai/ai/route/client"
import { decode } from "@toon-format/toon"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../../effect/app-node"
import { llmClient } from "../../effect/app-node-platform"
import { Catalog } from "../../catalog"
import { Config } from "../../config"
import { ConfigImageAnalyzer } from "../../config/image-analyzer"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import { IntegrationConnection } from "../../integration/connection"
import { ModelV2 } from "../../model"
import { SessionRunnerModel } from "./model"
import type { FileAttachment } from "@ycoding-ai/schema/prompt"

export const IMAGE_ANALYSIS_SCHEMA_VERSION = "1"

export const IMAGE_ANALYSIS_TOON_EXAMPLE = `version: "1"
image:
  name: photo.png
  mime: image/png
  digest: abc123def456abc123def456abc123def456abc123def456abc123def456abc123ab
  bytes: 12345
scene:
  overview: A cozy living room with a cat on a couch
objects[2]{type,count,description}:
  cat,1,orange tabby sitting on couch center
  pillow,2,white cushions behind cat
text_ocr[1]{content,location}:
  Hello,top-center sign
layout:
  arrangement: "cat centered in foreground, wall in background"
  spatial: "pillow behind cat, couch under cat"
  composition: "eye-level, rule of thirds"
colors:
  palette[3]: warm beige,orange,white
  style: "natural lighting, photorealistic"
  mood: cozy
details[2]: whiskers fine and sharp,soft shadows on wall
confidence:
  level: high
  uncertainties[1]: blurry background text partially occluded`

export const STANDARD_IMAGE_ANALYSIS_PROMPT = `You are a precise image analysis assistant. Output ONLY valid TOON matching the schema below. Use 2-space indent, explicit [N] and {fields}, tabular for uniform arrays, list-form for non-uniform. No JSON, no markdown wrapper except optional \`\`\`toon block (will be stripped) — no reasoning outside TOON.

Expected TOON schema — copy header template exactly, fill with observed values. Preserve all 7 sections as structured fields: scene.overview, objects, text_ocr, layout, colors, details, confidence. Measured/visible vs inferred separation via confidence.uncertainties.

\`\`\`toon
${IMAGE_ANALYSIS_TOON_EXAMPLE}
\`\`\`

Rules:
- Be factual, concise, avoid speculation beyond visible evidence. Deterministic language.
- Uniform object arrays MUST use tabular header like objects[2]{type,count,description}: then CSV rows.
- Primitive arrays MUST use inline like palette[3]: a,b,c or details[2]: a,b.
- For empty or absent arrays emit field: [].
- Keep TOON valid: quoted strings when needed, 2-space indent, no trailing prose.`

export const isMultimodal = (capabilities?: { readonly input?: readonly string[] }): boolean => {
  if (!capabilities?.input) return false
  return capabilities.input.some((item) => item.startsWith("image") || item === "vision" || item.includes("image"))
}

export const stripToonFences = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("```")) return trimmed
  const firstNewline = trimmed.indexOf("\n")
  if (firstNewline === -1) return trimmed
  const lastFence = trimmed.lastIndexOf("```")
  if (lastFence <= firstNewline) return trimmed
  return trimmed.slice(firstNewline + 1, lastFence).trim()
}

export const isValidToon = (raw: string): boolean => {
  const trimmed = stripToonFences(raw.trim())
  if (trimmed.length === 0) return false
  const hasMarker = /\[\d+\]/.test(trimmed) && trimmed.includes(":")
  if (!hasMarker) return false
  try {
    decode(trimmed)
    return true
  } catch {
    return false
  }
}

export const normalizeToonAnalysis = (raw: string): string => {
  const stripped = stripToonFences(raw).trim()
  if (stripped.length === 0) return stripped
  // Validate via decode when available; keep verbatim even if invalid to preserve output — validation is for downstream detection, not rejection
  // isValidToon uses decode internally; we just strip fences and trim here
  return stripped
}

export const formatFallbackBlock = (input: {
  readonly file: FileAttachment
  readonly analysis: string
  readonly modelLabel?: string
}): string => {
  const name = input.file.name ?? input.file.content.digest.slice(0, 12)
  const mime = input.file.mime
  const label = input.modelLabel ? ` via ${input.modelLabel}` : ""
  const toon = normalizeToonAnalysis(input.analysis)
  return [
    `[Image Analysis: ${name} (${mime})${label}]`,
    ``,
    "```toon",
    toon.trim(),
    "```",
    input.file.description ? `Original description: ${input.file.description}` : undefined,
    `SHA-256: ${input.file.content.digest}`,
    `Bytes: ${input.file.content.bytes}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export const failureBlock = (file: FileAttachment, error: string): string =>
  [
    `[Image Analysis: ${file.name ?? file.content.digest.slice(0, 12)} (${file.mime}) — FAILED]`,
    `Automated vision analysis failed: ${error}`,
    `Fallback: image could not be analyzed, but metadata is preserved below.`,
    `SHA-256: ${file.content.digest}`,
    `Bytes: ${file.content.bytes}`,
    file.description ? `Description: ${file.description}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")

export interface AnalyzeInput {
  readonly file: FileAttachment
  readonly bytes: Uint8Array
}

export interface Interface {
  readonly isMultimodalModel: (model: ModelV2.Info) => boolean
  readonly standardPrompt: string
  readonly analyze: (
    inputs: readonly AnalyzeInput[],
    options?: { readonly customPrompt?: string },
  ) => Effect.Effect<ReadonlyMap<string, string>>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/ImageAnalyzer") {}

const resolveVisionModel = Effect.fn("ImageAnalyzer.resolveVisionModel")(function* () {
  const config = yield* Config.Service
  const catalog = yield* Catalog.Service
  const integrations = yield* Integration.Service
  const entries = yield* config.entries()
  const info = Config.latest(entries, "image_analyzer")
  if (!info || info.enabled === false) return undefined
  const selection = ConfigImageAnalyzer.resolveSelection(info)
  if (!selection) return undefined
  const modelInfo = yield* catalog.model.get(selection.providerID, selection.model).pipe(
    Effect.orElseSucceed(() => undefined as unknown as ModelV2.Info | undefined),
  )
  if (!modelInfo) return undefined
  const provider = yield* catalog.provider.get(modelInfo.providerID).pipe(
    Effect.orElseSucceed(() => undefined as unknown as import("../../provider").ProviderV2.Info | undefined),
  )
  const connection = yield* integrations.connection
    .active(provider?.integrationID ?? Integration.ID.make(modelInfo.providerID))
    .pipe(Effect.orElseSucceed(() => undefined as unknown as IntegrationConnection.Info | undefined))
  const credential = connection
    ? yield* integrations.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
    : undefined
  const nested = yield* SessionRunnerModel.fromCatalogModel(modelInfo, credential).pipe(
    Effect.orElseSucceed(() => undefined as unknown as import("@ycoding-ai/ai").Model),
  )
  if (!nested) return undefined
  return { model: nested, ref: selection, info, modelInfo }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const llm = yield* LLMClient.Service
    const config = yield* Config.Service
    const catalog = yield* Catalog.Service
    const integrations = yield* Integration.Service

    const resolveLocal = Effect.fn("ImageAnalyzer.resolveVisionModel.local")(function* () {
      const entries = yield* config.entries()
      const info = Config.latest(entries, "image_analyzer")
      if (!info || info.enabled === false) return undefined
      const selection = ConfigImageAnalyzer.resolveSelection(info)
      if (!selection) return undefined
      const modelInfo = yield* catalog.model.get(selection.providerID, selection.model).pipe(
        Effect.orElseSucceed(() => undefined as unknown as ModelV2.Info | undefined),
      )
      if (!modelInfo) return undefined
      const provider = yield* catalog.provider.get(modelInfo.providerID).pipe(
        Effect.orElseSucceed(() => undefined as unknown as import("../../provider").ProviderV2.Info | undefined),
      )
      const connection = yield* integrations.connection
        .active(provider?.integrationID ?? Integration.ID.make(modelInfo.providerID))
        .pipe(Effect.orElseSucceed(() => undefined as unknown as IntegrationConnection.Info | undefined))
      const credential = connection
        ? yield* integrations.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
        : undefined
      const nested = yield* SessionRunnerModel.fromCatalogModel(modelInfo, credential).pipe(
        Effect.orElseSucceed(() => undefined as unknown as import("@ycoding-ai/ai").Model),
      )
      if (!nested) return undefined
      return { model: nested, ref: selection, info, modelInfo }
    })

    return Service.of({
      isMultimodalModel: (model) => isMultimodal(model.capabilities),
      standardPrompt: STANDARD_IMAGE_ANALYSIS_PROMPT,
      analyze: Effect.fn("ImageAnalyzer.analyze")(function* (
        inputs: readonly AnalyzeInput[],
        options?: { readonly customPrompt?: string },
      ) {
        if (inputs.length === 0) return new Map<string, string>()
        const vision = yield* resolveLocal()
        if (!vision) {
          return new Map(
            inputs.map(({ file }) => [file.content.digest, failureBlock(file, "vision model not configured or unavailable")]),
          )
        }
        const info = vision.info
        const maxImages = info.max_images
        const maxBytes = info.max_bytes
        const prompt = options?.customPrompt ?? ConfigImageAnalyzer.effectivePrompt(info) ?? STANDARD_IMAGE_ANALYSIS_PROMPT
        const label = `${String(vision.ref.providerID)}/${String(vision.ref.model)}${vision.ref.variant ? `#${vision.ref.variant}` : ""}`

        const limited = maxImages !== undefined ? inputs.slice(0, maxImages) : inputs
        const overflow: readonly AnalyzeInput[] = maxImages !== undefined ? inputs.slice(maxImages) : []

        const results: ReadonlyArray<readonly [string, string]> = yield* Effect.forEach(
          limited,
          (input) =>
            Effect.gen(function* () {
              if (maxBytes !== undefined && input.bytes.length > maxBytes) {
                return [input.file.content.digest, failureBlock(input.file, `image exceeds max_bytes ${maxBytes}`)] as const
              }
              const request = LLM.request({
                model: vision.model,
                system: prompt,
                messages: [
                  Message.make({
                    role: "user",
                    content: [
                      { type: "media", mediaType: input.file.mime, data: input.bytes, filename: input.file.name },
                      { type: "text", text: "Describe this image per the system instructions. Output ONLY TOON." },
                    ],
                  }),
                ],
              })
              const text = yield* Effect.gen(function* () {
                const response = yield* llm.generate(request)
                const joined = response.events
                  .filter((event) => event.type === "text-delta" || event.type === "text-end")
                  .map((event) => (event.type === "text-delta" ? (event as { text: string }).text : ""))
                  .join("")
                  .trim()
                return joined
              }).pipe(Effect.orElseSucceed(() => "[analysis failed]"))
              const raw = text.length > 0 ? text : "[no description returned]"
              const normalized = normalizeToonAnalysis(raw)
              // Validate via decode for telemetry; keep verbatim even if invalid to avoid dropping content
              if (normalized.length > 0) isValidToon(normalized)
              const analysis = normalized.length > 0 ? normalized : raw.trim()
              return [input.file.content.digest, formatFallbackBlock({ file: input.file, analysis, modelLabel: label })] as const
            }),
          { concurrency: 3 },
        )

        const overflowResults = overflow.map(
          ({ file }) => [file.content.digest, failureBlock(file, `exceeds max_images ${maxImages}`)] as const,
        )

        return new Map([...results, ...overflowResults])
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [llmClient, Catalog.node, Config.node, Integration.node, Credential.node],
})

export const detectMultimodal = isMultimodal
