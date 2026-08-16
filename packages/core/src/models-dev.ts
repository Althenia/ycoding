import path from "path"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ModelsDev } from "@ycoding-ai/schema/models-dev"
import { Money } from "@ycoding-ai/schema/money"
import { Global } from "./global"
import { Flock } from "./util/flock"
import { Hash } from "./util/hash"
import { FSUtil } from "./fs-util"
import { InstallationChannel, InstallationVersion } from "./installation/version"
import { EventV2 } from "./event"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { ModelV2 } from "./model"
import { ProviderV2 } from "./provider"

export const CatalogModelStatus = Schema.Literals(["alpha", "beta", "deprecated"])
export type CatalogModelStatus = typeof CatalogModelStatus.Type

const SourceCostFields = {
  input: Money.USDPerMillionTokens,
  output: Money.USDPerMillionTokens,
  cache_read: Schema.optional(Money.USDPerMillionTokens),
  cache_write: Schema.optional(Money.USDPerMillionTokens),
}

const SourceCost = Schema.Struct({
  ...SourceCostFields,
  tiers: Schema.optional(
    Schema.Array(
      Schema.Struct({
        ...SourceCostFields,
        tier: Schema.Struct({ type: Schema.Literal("context"), size: Schema.Number }),
      }),
    ),
  ),
  context_over_200k: Schema.optional(Schema.Struct(SourceCostFields)),
})
type Cost = typeof SourceCost.Type

const ReasoningOption = Schema.Union([
  Schema.Struct({ type: Schema.Literal("effort"), values: Schema.Array(Schema.NullOr(Schema.String)) }),
  Schema.Struct({ type: Schema.Literal("toggle") }),
  Schema.Struct({
    type: Schema.Literal("budget_tokens"),
    min: Schema.optional(Schema.Number),
    max: Schema.optional(Schema.Number),
  }),
])
type ReasoningOption = typeof ReasoningOption.Type

const Modality = Schema.Literals(["text", "audio", "image", "video", "pdf"])
type Modality = typeof Modality.Type

const SourceRequest = Schema.Struct({
  body: Schema.optional(ProviderV2.Settings),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
})

const SourceModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  family: Schema.optional(Schema.String),
  release_date: Schema.String,
  attachment: Schema.Boolean,
  reasoning: Schema.Boolean,
  reasoning_options: Schema.optional(Schema.Array(ReasoningOption)),
  temperature: Schema.optional(Schema.Boolean),
  tool_call: Schema.Boolean,
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({ field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]) }),
    ]),
  ),
  cost: Schema.optional(SourceCost),
  limit: Schema.Struct({
    context: Schema.Number,
    input: Schema.optional(Schema.Number),
    output: Schema.Number,
  }),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.Array(Modality),
      output: Schema.Array(Modality),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      modes: Schema.optional(
        Schema.Record(
          Schema.String,
          Schema.Struct({
            cost: Schema.optional(SourceCost),
            provider: Schema.optional(SourceRequest),
          }),
        ),
      ),
    }),
  ),
  status: Schema.optional(CatalogModelStatus),
  provider: Schema.optional(
    Schema.Struct({
      npm: Schema.optional(Schema.String),
      api: Schema.optional(Schema.String),
    }),
  ),
})
type SourceModel = typeof SourceModel.Type

const SourceProvider = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.String,
  env: Schema.Array(Schema.String),
  id: Schema.String,
  npm: Schema.optional(Schema.String),
  models: Schema.Record(Schema.String, SourceModel),
})
type SourceProvider = typeof SourceProvider.Type

const SourceProviders = Schema.Record(Schema.String, SourceProvider)
const decodeSourceProviders = Schema.decodeUnknownEffect(SourceProviders)
const decodeSourceProvidersJson = Schema.decodeUnknownEffect(Schema.fromJsonString(SourceProviders))

export type Snapshot = {
  readonly info: ProviderV2.Info
  readonly models: readonly ModelV2.Info[]
  readonly environment: readonly string[]
}

function normalize(input: Record<string, SourceProvider>): readonly Snapshot[] {
  const providers: Snapshot[] = []
  for (const item of Object.values(input)) {
    const providerID = ProviderV2.ID.make(item.id)
    const info = {
      id: providerID,
      name: item.name,
      package: item.npm ? ProviderV2.aisdk(item.npm) : "",
      ...(item.api ? { settings: { baseURL: item.api } } : {}),
    } satisfies ProviderV2.Info
    const models: ModelV2.Info[] = []
    for (const model of Object.values(item.models)) {
      const baseCost = cost(model.cost)
      const variants = reasoningVariants(item, model)
      const id = ModelV2.ID.make(model.id)
      models.push(modelInfo(providerID, id, model, { cost: baseCost, variants }))
      for (const [mode, options] of Object.entries(model.experimental?.modes ?? {})) {
        const modeID = ModelV2.ID.make(`${model.id}-${mode}`)
        models.push(
          modelInfo(providerID, modeID, model, {
            name: modeName(model, mode),
            cost: mergeCost(baseCost, options.cost),
            request: options.provider,
            variants,
          }),
        )
      }
    }
    providers.push({ info, models, environment: [...item.env] })
  }
  return providers
}

function released(date: string) {
  const time = Date.parse(date)
  return Number.isFinite(time) ? time : 0
}

function cost(input: SourceModel["cost"]): ModelV2.Info["cost"] {
  const base = {
    input: input?.input ?? Money.USDPerMillionTokens.zero,
    output: input?.output ?? Money.USDPerMillionTokens.zero,
    cache: {
      read: input?.cache_read ?? Money.USDPerMillionTokens.zero,
      write: input?.cache_write ?? Money.USDPerMillionTokens.zero,
    },
  }
  return [
    base,
    ...(input?.tiers?.map((item) => ({
      tier: item.tier,
      input: item.input,
      output: item.output,
      cache: {
        read: item.cache_read ?? Money.USDPerMillionTokens.zero,
        write: item.cache_write ?? Money.USDPerMillionTokens.zero,
      },
    })) ?? []),
    ...(input?.context_over_200k
      ? [
          {
            tier: { type: "context" as const, size: 200_000 },
            input: input.context_over_200k.input,
            output: input.context_over_200k.output,
            cache: {
              read: input.context_over_200k.cache_read ?? Money.USDPerMillionTokens.zero,
              write: input.context_over_200k.cache_write ?? Money.USDPerMillionTokens.zero,
            },
          },
        ]
      : []),
  ]
}

function mergeCost(base: ModelV2.Info["cost"], override: SourceModel["cost"] | undefined) {
  if (!override) return base
  const next = cost(override)
  const [baseDefault, ...baseTiers] = base
  const [nextDefault, ...nextTiers] = next
  const tierKey = (item: ModelV2.Info["cost"][number]) => `${item.tier?.type ?? "base"}:${item.tier?.size ?? 0}`
  const merge = (left: ModelV2.Info["cost"][number], right: ModelV2.Info["cost"][number]) => ({
    ...left,
    ...right,
    tier: right.tier ?? left.tier,
    cache: { ...left.cache, ...right.cache },
  })
  const tiers = new Map(baseTiers.map((item) => [tierKey(item), item]))
  for (const item of nextTiers) {
    const current = tiers.get(tierKey(item))
    tiers.set(tierKey(item), current ? merge(current, item) : item)
  }
  return [
    merge(
      baseDefault ?? {
        input: Money.USDPerMillionTokens.zero,
        output: Money.USDPerMillionTokens.zero,
        cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
      },
      nextDefault,
    ),
    ...tiers.values(),
  ]
}

const OPENAI_INCLUDE_ENCRYPTED_REASONING = ["reasoning.encrypted_content"]
const OUTPUT_TOKEN_MAX = 32_000

function reasoningVariants(provider: SourceProvider, model: SourceModel): NonNullable<ModelV2.Info["variants"]> {
  const npm = model.provider?.npm ?? provider.npm
  const options = model.reasoning_options
  if (!options?.length || npm === undefined) return []
  const toggle = options.some((option) => option.type === "toggle")
  const effort = options.find((option) => option.type === "effort")
  if (effort?.type === "effort") {
    const off = toggle ? toggleVariants(npm, model.id).filter((variant) => variant.id === "none") : []
    const variants = [
      ...off,
      ...effort.values.flatMap((value) => {
        const raw: unknown = value
        const id = typeof raw === "string" && raw !== "null" ? raw : undefined
        if (id === undefined) return []
        if (id === "none" && off.length > 0) return []
        const settings = settingsForEffort(npm, model.id, id)
        return settings ? [{ id: ModelV2.VariantID.make(id), settings }] : []
      }),
    ]
    return [...new Map(variants.map((variant) => [variant.id, variant])).values()]
  }
  const budget = options.find((option) => option.type === "budget_tokens")
  if (budget?.type === "budget_tokens")
    return [
      ...(toggle ? toggleVariants(npm, model.id).filter((variant) => variant.id === "none") : []),
      ...budgetVariants(npm, model, budget),
    ]
  if (toggle) return toggleVariants(npm, model.id)
  return []
}

function settingsForEffort(npm: string, modelID: string, effort: string): ProviderV2.Settings | undefined {
  if (npm === "@openrouter/ai-sdk-provider") return { reasoning: { effort } }
  if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") {
    if (anthropicManualThinking(modelID)) return { effort }
    return {
      thinking: { type: "adaptive", display: "summarized" },
      effort,
    }
  }
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex")
    return { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } }
  if (npm === "@ai-sdk/amazon-bedrock") {
    if (modelID.includes("anthropic"))
      return {
        reasoningConfig: {
          ...(anthropicManualThinking(modelID) ? {} : { type: "adaptive", display: "summarized" }),
          maxReasoningEffort: effort,
        },
      }
    return { reasoningConfig: { type: "enabled", maxReasoningEffort: effort } }
  }
  if (npm === "@ai-sdk/gateway") {
    const upstream = gatewayPackage(modelID)
    if (upstream) return settingsForEffort(upstream, modelID, effort)
    return { reasoningEffort: effort }
  }
  if (npm === "@ai-sdk/github-copilot") {
    if (modelID.includes("gemini")) return
    if (modelID.includes("claude")) return { reasoningEffort: effort }
    return { reasoningEffort: effort, reasoningSummary: "auto", include: OPENAI_INCLUDE_ENCRYPTED_REASONING }
  }
  if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/amazon-bedrock/mantle" || npm === "@ai-sdk/azure")
    return { reasoningEffort: effort, reasoningSummary: "auto", include: OPENAI_INCLUDE_ENCRYPTED_REASONING }
  if (npm === "@jerome-benoit/sap-ai-provider-v2") {
    if (modelID.includes("anthropic"))
      return {
        modelParams: {
          additionalModelRequestFields: {
            ...(anthropicManualThinking(modelID) ? {} : { thinking: { type: "adaptive", display: "summarized" } }),
            output_config: { effort },
          },
        },
      }
    if (modelID.includes("gemini"))
      return { modelParams: { thinkingConfig: { includeThoughts: true, thinkingLevel: effort } } }
    if (modelID.includes("amazon--nova"))
      return { modelParams: { additionalModelRequestFields: { output_config: { effort } } } }
    return { modelParams: { reasoning_effort: effort } }
  }
  if (
    [
      "@ai-sdk/openai-compatible",
      "@ai-sdk/xai",
      "@ai-sdk/mistral",
      "@ai-sdk/groq",
      "@ai-sdk/cerebras",
      "@ai-sdk/deepinfra",
      "@ai-sdk/togetherai",
      "venice-ai-sdk-provider",
      "ai-gateway-provider",
    ].includes(npm)
  )
    return { reasoningEffort: effort }
}

function budgetVariants(
  npm: string,
  model: SourceModel,
  option: Extract<NonNullable<SourceModel["reasoning_options"]>[number], { type: "budget_tokens" }>,
): NonNullable<ModelV2.Info["variants"]> {
  const maximum = Math.min(option.max ?? OUTPUT_TOKEN_MAX - 1, model.limit.output - 1, OUTPUT_TOKEN_MAX - 1)
  if (maximum <= 0) return []
  const high = Math.min(Math.max(option.min ?? 0, Math.floor((maximum + 1) / 2)), maximum)
  return [
    { id: "high", budget: high },
    { id: "max", budget: maximum },
  ].flatMap((item) => {
    const settings = settingsForBudget(npm, model.id, item.budget)
    return settings ? [{ id: ModelV2.VariantID.make(item.id), settings }] : []
  })
}

function toggleVariants(npm: string, modelID: string): NonNullable<ModelV2.Info["variants"]> {
  if (npm === "@ai-sdk/gateway") {
    const upstream = gatewayPackage(modelID)
    if (upstream) return toggleVariants(upstream, modelID)
    return [
      {
        id: ModelV2.VariantID.make("none"),
        settings: { reasoning: { enabled: false } },
      },
      {
        id: ModelV2.VariantID.make("thinking"),
        settings: { reasoning: { enabled: true } },
      },
    ]
  }
  if (npm === "@openrouter/ai-sdk-provider")
    return [
      { id: ModelV2.VariantID.make("none"), settings: { reasoning: { enabled: false } } },
      { id: ModelV2.VariantID.make("thinking"), settings: { reasoning: { enabled: true } } },
    ]
  if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic")
    return [
      { id: ModelV2.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
      {
        id: ModelV2.VariantID.make("thinking"),
        settings: {
          thinking: { type: "adaptive", display: "summarized" },
        },
      },
    ]
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex")
    return [
      {
        id: ModelV2.VariantID.make("none"),
        settings: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } },
      },
      {
        id: ModelV2.VariantID.make("thinking"),
        settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
      },
    ]
  if (npm === "@ai-sdk/amazon-bedrock") {
    const anthropic = modelID.includes("anthropic")
    return [
      {
        id: ModelV2.VariantID.make("none"),
        settings: {
          additionalModelRequestFields: anthropic
            ? { thinking: { type: "disabled" } }
            : { reasoningConfig: { type: "disabled" } },
        },
      },
      {
        id: ModelV2.VariantID.make("thinking"),
        settings: {
          additionalModelRequestFields: anthropic
            ? { thinking: { type: "adaptive", display: "summarized" } }
            : { reasoningConfig: { type: "enabled" } },
        },
      },
    ]
  }
  if (npm === "@ai-sdk/alibaba")
    return [
      { id: ModelV2.VariantID.make("none"), settings: { enableThinking: false } },
      { id: ModelV2.VariantID.make("thinking"), settings: { enableThinking: true } },
    ]
  if (npm === "@ai-sdk/cohere")
    return [
      { id: ModelV2.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
      { id: ModelV2.VariantID.make("thinking"), settings: { thinking: { type: "enabled" } } },
    ]
  if (npm === "@jerome-benoit/sap-ai-provider-v2") {
    if (modelID.includes("gemini"))
      return [
        {
          id: ModelV2.VariantID.make("none"),
          settings: { modelParams: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } },
        },
        {
          id: ModelV2.VariantID.make("thinking"),
          settings: { modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } } },
        },
      ]
    if (modelID.includes("cohere"))
      return [
        {
          id: ModelV2.VariantID.make("none"),
          settings: { modelParams: { thinking: { type: "disabled" } } },
        },
        {
          id: ModelV2.VariantID.make("thinking"),
          settings: { modelParams: { thinking: { type: "enabled" } } },
        },
      ]
    if (modelID.includes("amazon--nova"))
      return [
        {
          id: ModelV2.VariantID.make("none"),
          settings: { modelParams: { additionalModelRequestFields: { thinking: { type: "disabled" } } } },
        },
        {
          id: ModelV2.VariantID.make("thinking"),
          settings: { modelParams: { additionalModelRequestFields: { thinking: { type: "enabled" } } } },
        },
      ]
    if (modelID.includes("anthropic"))
      return [
        {
          id: ModelV2.VariantID.make("none"),
          settings: {
            modelParams: { additionalModelRequestFields: { thinking: { type: "disabled" } } },
          },
        },
        {
          id: ModelV2.VariantID.make("thinking"),
          settings: {
            modelParams: {
              additionalModelRequestFields: {
                thinking: { type: "adaptive", display: "summarized" },
              },
            },
          },
        },
      ]
  }
  return []
}

function settingsForBudget(npm: string, modelID: string, budget: number): ProviderV2.Settings | undefined {
  if (npm === "@openrouter/ai-sdk-provider") return { reasoning: { max_tokens: budget } }
  if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic")
    return { thinking: { type: "enabled", budgetTokens: budget } }
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex")
    return { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } }
  if (npm === "@ai-sdk/amazon-bedrock") return { reasoningConfig: { type: "enabled", budgetTokens: budget } }
  if (npm === "@ai-sdk/gateway") {
    const upstream = gatewayPackage(modelID)
    return upstream ? settingsForBudget(upstream, modelID, budget) : { reasoning: { max_tokens: budget } }
  }
  if (npm === "@ai-sdk/cohere") return { thinking: { type: "enabled", tokenBudget: budget } }
  if (npm === "@ai-sdk/alibaba") return { enableThinking: true, thinkingBudget: budget }
  if (npm === "@jerome-benoit/sap-ai-provider-v2") {
    if (modelID.includes("anthropic"))
      return {
        modelParams: {
          additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: budget } },
        },
      }
    if (modelID.includes("gemini"))
      return { modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: budget } } }
    if (modelID.includes("cohere")) return { modelParams: { thinking: { type: "enabled", token_budget: budget } } }
  }
}

function gatewayPackage(modelID: string) {
  const separator = modelID.indexOf("/")
  if (separator <= 0) return
  const prefix = modelID.slice(0, separator)
  if (prefix === "anthropic") return "@ai-sdk/anthropic"
  if (prefix === "google") return "@ai-sdk/google"
  if (prefix === "amazon") return "@ai-sdk/amazon-bedrock"
  if (prefix === "alibaba") return "@ai-sdk/alibaba"
}

function anthropicManualThinking(modelID: string) {
  const familyFirst = /(?:claude-)?(?:opus|sonnet|haiku)-(\d+)(?:[.-](\d+))?/i.exec(modelID)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(?:opus|sonnet|haiku)/i.exec(modelID)
  const major = Number(familyFirst?.[1] ?? versionFirst?.[1])
  const rawMinor = Number(familyFirst?.[2] ?? versionFirst?.[2] ?? 0)
  if (!Number.isFinite(major)) return false
  const minor = rawMinor > 9 ? 0 : rawMinor
  return major < 4 || (major === 4 && minor < 6)
}

function modeName(model: SourceModel, mode: string) {
  return `${model.name} ${mode.charAt(0).toUpperCase()}${mode.slice(1)}`
}

function modelInfo(
  providerID: ProviderV2.ID,
  id: ModelV2.ID,
  model: SourceModel,
  input: {
    readonly name?: string
    readonly cost?: ModelV2.Info["cost"]
    readonly request?: NonNullable<NonNullable<SourceModel["experimental"]>["modes"]>[string]["provider"]
    readonly variants?: NonNullable<ModelV2.Info["variants"]>
  } = {},
): ModelV2.Info {
  return {
    id,
    modelID: ModelV2.ID.make(model.id),
    providerID,
    name: input.name ?? model.name,
    family: model.family ? ModelV2.Family.make(model.family) : undefined,
    package: model.provider?.npm ? ProviderV2.aisdk(model.provider.npm) : undefined,
    settings: model.provider?.api ? { baseURL: model.provider.api } : undefined,
    capabilities: {
      tools: model.tool_call,
      input: [...(model.modalities?.input ?? [])],
      output: [...(model.modalities?.output ?? [])],
    },
    variants: [...(input.variants ?? [])],
    time: { released: released(model.release_date) },
    cost: (input.cost ?? cost(model.cost)).map((item) => ({
      ...item,
      tier: item.tier && { ...item.tier },
      cache: { ...item.cache },
    })),
    status: model.status ?? "active",
    enabled: true,
    limit: { context: model.limit.context, input: model.limit.input, output: model.limit.output },
    headers: input.request?.headers ? { ...input.request.headers } : undefined,
    body: input.request?.body ? { ...input.request.body } : undefined,
  }
}

export const Event = ModelsDev.Event

declare const YCODING_MODELS_DEV: Record<string, SourceProvider> | undefined

export interface Interface {
  readonly get: () => Effect.Effect<readonly Snapshot[]>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export const Options = Schema.Struct({
  url: Schema.optional(Schema.String),
  file: Schema.optional(Schema.String),
  fetch: Schema.optional(Schema.Boolean),
  client: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@ycoding/ModelsDev") {}

export const layer = (options?: Options) => Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const events = yield* EventV2.Service
    const http = HttpClient.filterStatusOk(
      (yield* HttpClient.HttpClient).pipe(
        HttpClient.retryTransient({
          retryOn: "errors-and-responses",
          times: 2,
          schedule: Schedule.exponential(200).pipe(Schedule.jittered),
        }),
      ),
    )

    const source = options?.url ?? "https://models.dev"
    const fetch = options?.fetch ?? true
    const userAgent = `ycoding/${InstallationChannel}/${InstallationVersion}/${options?.client ?? "cli"}`
    const filepath = path.join(
      Global.Path.cache,
      source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
    )
    const ttl = Duration.minutes(5)
    const lockKey = `models-dev:${filepath}`

    const fresh = Effect.fnUntraced(function* () {
      const stat = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!stat) return false
      const mtime = Option.getOrElse(stat.mtime, () => new Date(0)).getTime()
      return Date.now() - mtime < Duration.toMillis(ttl)
    })

    const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
      return yield* HttpClientRequest.get(`${source}/api.json`).pipe(
        HttpClientRequest.setHeader("User-Agent", userAgent),
        http.execute,
        Effect.flatMap((res) => res.text),
        Effect.timeout("10 seconds"),
      )
    })

    const loadFromDisk = fs.readJson(options?.file ?? filepath).pipe(
      Effect.flatMap(decodeSourceProviders),
      Effect.catch(() =>
        options?.file === undefined
          ? fs.remove(filepath, { force: true }).pipe(Effect.ignore, Effect.as(undefined))
          : Effect.succeed(undefined),
      ),
    )

    const loadSnapshot = Effect.sync(() =>
      typeof YCODING_MODELS_DEV === "undefined" ? undefined : YCODING_MODELS_DEV,
    )

    const fetchAndWrite = Effect.fn("ModelsDev.fetchAndWrite")(function* () {
      const text = yield* fetchApi()
      const providers = yield* decodeSourceProvidersJson(text)
      const tempfile = `${filepath}.${process.pid}.${Date.now()}.tmp`
      yield* fs.writeWithDirs(tempfile, text).pipe(
        Effect.andThen(fs.rename(tempfile, filepath)),
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* fs.remove(tempfile, { force: true }).pipe(Effect.ignore)
            return yield* Effect.fail(error)
          }),
        ),
      )
      return providers
    })

    const populate = Effect.gen(function* () {
      const fromDisk = yield* loadFromDisk
      if (fromDisk) return normalize(fromDisk)
      const bundled = yield* loadSnapshot
      if (bundled) return normalize(bundled)
      if (!fetch) return []
      // Flock is cross-process: concurrent ycoding CLIs can race on this cache file.
      const providers = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          return yield* fetchAndWrite()
        }),
      )
      return normalize(providers)
    }).pipe(Effect.withSpan("ModelsDev.populate"), Effect.orDie)

    const [cachedGet, invalidate] = yield* Effect.cachedInvalidateWithTTL(populate, Duration.infinity)

    const get = (): Effect.Effect<readonly Snapshot[]> => cachedGet

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (!force && (yield* fresh())) return
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Flock.effect(lockKey)
          // Re-check under the lock: another process may have refreshed between
          // our outer check and lock acquisition.
          if (!force && (yield* fresh())) return
          yield* fetchAndWrite()
          yield* invalidate
          yield* events.publish(Event.Refreshed, {})
        }),
      ).pipe(
        Effect.tapCause((cause) => Effect.logError("Failed to fetch models.dev", { cause: cause })),
        Effect.ignore,
      )
    })

    if (fetch && !process.argv.includes("--get-yargs-completions")) {
      // Schedule.spaced runs the effect once, then waits between completions.
      yield* Effect.forkScoped(refresh().pipe(Effect.repeat(Schedule.spaced("60 minutes")), Effect.ignore))
    }

    return Service.of({ get, refresh })
  }),
)

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [FSUtil.node, EventV2.node, httpClient] })
}

export const node = configured()

export * as ModelsDev from "./models-dev"
