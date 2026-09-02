export * as ConfigProviderPlugin from "./provider"

import { define } from "@ycoding-ai/plugin/effect/plugin"
import { Money } from "@ycoding-ai/schema/money"
import { Effect, Stream } from "effect"
import { Config } from "../../config"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"

type DiscoveredModel = {
  readonly id: string
  readonly name?: string
  readonly capabilities?: { readonly tools?: boolean; readonly input?: string[]; readonly output?: string[] }
  readonly variants?: Array<{
    readonly id: string
    readonly settings?: Record<string, unknown>
    readonly headers?: Record<string, string>
    readonly body?: Record<string, unknown>
  }>
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

function parseModels(value: unknown): DiscoveredModel[] {
  const root = record(value)
  if (root?.object !== "list" || !Array.isArray(root.data)) throw new Error("invalid OpenAI model catalog")
  return root.data.map((candidate) => {
    const item = record(candidate)
    if (!item || typeof item.id !== "string" || !item.id) throw new Error("invalid OpenAI model record")
    const capabilities = record(item.capabilities)
    const variants = Array.isArray(item.variants)
      ? item.variants.flatMap((candidate) => {
          const variant = record(candidate)
          if (!variant || typeof variant.id !== "string" || !variant.id) return []
          return [
            {
              id: variant.id,
              ...(record(variant.settings) ? { settings: variant.settings as Record<string, unknown> } : {}),
              ...(record(variant.headers) ? { headers: variant.headers as Record<string, string> } : {}),
              ...(record(variant.body) ? { body: variant.body as Record<string, unknown> } : {}),
            },
          ]
        })
      : undefined
    return {
      id: item.id,
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      ...(capabilities
        ? {
            capabilities: {
              ...(typeof capabilities.tools === "boolean" ? { tools: capabilities.tools } : {}),
              ...(Array.isArray(capabilities.input) && capabilities.input.every((item) => typeof item === "string")
                ? { input: capabilities.input as string[] }
                : {}),
              ...(Array.isArray(capabilities.output) && capabilities.output.every((item) => typeof item === "string")
                ? { output: capabilities.output as string[] }
                : {}),
            },
          }
        : {}),
      ...(variants ? { variants } : {}),
    }
  })
}

const discover = Effect.fn("ConfigProviderPlugin.discover")(function* (entries: readonly Config.Entry[]) {
  const configured = new Map<
    string,
    { settings: Record<string, unknown>; headers: Record<string, string>; source?: string }
  >()
  for (const entry of entries) {
    if (entry.type !== "document") continue
    for (const [id, provider] of Object.entries(entry.info.providers ?? {})) {
      const previous = configured.get(id) ?? { settings: {}, headers: {} }
      configured.set(id, {
        settings: { ...previous.settings, ...(provider.settings ?? {}) },
        headers: { ...previous.headers, ...(provider.headers ?? {}) },
        source: provider.catalog?.source ?? previous.source,
      })
    }
  }
  const result = new Map<string, DiscoveredModel[]>()
  yield* Effect.forEach(
    [...configured.entries()].filter(([, provider]) => provider.source === "openai-models"),
    ([id, provider]) =>
      Effect.tryPromise({
        try: async () => {
          const baseURL = provider.settings.baseURL
          if (typeof baseURL !== "string" || !baseURL) throw new Error("provider baseURL is required")
          const headers = new Headers(provider.headers)
          const apiKey = provider.settings.apiKey
          if (!headers.has("authorization") && typeof apiKey === "string" && apiKey)
            headers.set("authorization", `Bearer ${apiKey}`)
          const response = await fetch(`${baseURL.replace(/\/$/, "")}/models`, {
            headers,
            signal: AbortSignal.timeout(5_000),
          })
          if (!response.ok) throw new Error(`model discovery failed with HTTP ${response.status}`)
          result.set(id, parseModels(await response.json()))
        },
        catch: () => new Error("OpenAI model discovery failed"),
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("OpenAI model discovery failed", { providerID: id }).pipe(Effect.asVoid),
        ),
      ),
    { discard: true },
  )
  return result
})

let sharedEntries: readonly Config.Entry[] | undefined

export const Plugin = define({
  id: "ycoding.config.provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const initial = yield* config.entries()
    if (sharedEntries === undefined) sharedEntries = initial
    const loaded = {
      get entries() {
        return sharedEntries!
      },
      set entries(value: readonly Config.Entry[]) {
        sharedEntries = value
      },
      discovered: yield* discover(initial),
    }
    // Ensure this location starts with latest global entries (covers subagent locations created after a config change)
    loaded.entries = initial
    yield* ctx.integration.transform((integrations) => {
      const files = loaded.entries.filter((entry): entry is Config.Document => entry.type === "document")
      const configuredIntegrations = new Set(
        files.flatMap((file) =>
          Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
            provider.env === undefined ? [] : [id],
          ),
        ),
      )
      for (const file of files) {
        for (const [id, item] of Object.entries(file.info.providers ?? {})) {
          const integrationID = id
          if (!configuredIntegrations.has(id) && !integrations.get(integrationID)) continue
          integrations.update(integrationID, (integration) => {
            integration.name = item.name ?? integration.name
          })
          if (item.env !== undefined) {
            integrations.method.update({
              integrationID,
              method: { type: "env", names: [...item.env] },
            })
          }
        }
      }
    })

    yield* ctx.catalog.transform((catalog) => {
      const files = loaded.entries.filter((entry): entry is Config.Document => entry.type === "document")
      const configuredDefault = Config.latest(loaded.entries, "model")
      if (configuredDefault !== undefined)
        catalog.model.default.set(configuredDefault.providerID, configuredDefault.model)
      for (const [providerID, models] of loaded.discovered) {
        for (const discovered of models) {
          const candidates = catalog.provider
            .list()
            .filter((record) => record.provider.id !== providerID)
            .flatMap((record) =>
              [...record.models.values()]
                .filter(
                  (model) =>
                    model.id === discovered.id ||
                    model.modelID === discovered.id ||
                    (!!discovered.name && model.name === discovered.name),
                )
                .map((model) => ({ providerID: record.provider.id, model })),
            )
          const source =
            candidates.find((candidate) => candidate.providerID === ProviderV2.ID.openrouter)?.model ??
            candidates.find((candidate) => candidate.providerID === ProviderV2.ID.openai)?.model ??
            candidates[0]?.model
          catalog.model.update(ProviderV2.ID.make(providerID), ModelV2.ID.make(discovered.id), (model) => {
            model.modelID = ModelV2.ID.make(discovered.id)
            if (discovered.name) model.name = discovered.name
            if (source?.family) model.family = source.family
            if (source?.limit) model.limit = { ...source.limit }
            if (source?.cost) model.cost = source.cost.map((cost) => ({ ...cost, cache: { ...cost.cache } }))
            model.capabilities = {
              tools: discovered.capabilities?.tools ?? source?.capabilities.tools ?? false,
              input: [...(discovered.capabilities?.input ?? source?.capabilities.input ?? ["text"])],
              output: [...(discovered.capabilities?.output ?? source?.capabilities.output ?? ["text"])],
            }
            if (discovered.variants)
              model.variants = discovered.variants.map((variant) => ({
                id: ModelV2.VariantID.make(variant.id),
                ...(variant.settings ? { settings: { ...variant.settings } } : {}),
                ...(variant.headers ? { headers: { ...variant.headers } } : {}),
                ...(variant.body ? { body: { ...variant.body } } : {}),
              }))
          })
        }
      }
      for (const file of files) {
        for (const [id, item] of Object.entries(file.info.providers ?? {})) {
          const providerID = id
          catalog.provider.update(providerID, (provider) => {
            if (item.name !== undefined) provider.name = item.name
            if (item.package !== undefined) provider.package = item.package
            if (item.settings !== undefined)
              provider.settings = ProviderV2.mergeOverlay(provider.settings, item.settings)
            if (item.headers !== undefined) provider.headers = ProviderV2.mergeHeaders(provider.headers, item.headers)
            if (item.body !== undefined) provider.body = ProviderV2.mergeOverlay(provider.body, item.body)
          })
          for (const [id, config] of Object.entries(item.models ?? {})) {
            catalog.model.update(providerID, id, (model) => {
              if (config.family !== undefined) model.family = config.family
              if (config.name !== undefined) model.name = config.name
              if (config.modelID !== undefined) model.modelID = config.modelID
              if (config.package !== undefined) model.package = config.package
              if (config.settings !== undefined)
                model.settings = ProviderV2.mergeOverlay(model.settings, config.settings)
              if (config.headers !== undefined) model.headers = ProviderV2.mergeHeaders(model.headers, config.headers)
              if (config.body !== undefined) model.body = ProviderV2.mergeOverlay(model.body, config.body)
              if (config.capabilities !== undefined) {
                if (config.capabilities.tools !== undefined) model.capabilities.tools = config.capabilities.tools
                if (config.capabilities.input !== undefined) model.capabilities.input = [...config.capabilities.input]
                if (config.capabilities.output !== undefined)
                  model.capabilities.output = [...config.capabilities.output]
              }
              if (config.variants !== undefined) {
                model.variants ??= []
                for (const variant of config.variants) {
                  let existing = model.variants.find((item) => item.id === variant.id)
                  if (!existing) {
                    existing = { id: variant.id }
                    model.variants.push(existing)
                  }
                  if (variant.settings !== undefined)
                    existing.settings = ProviderV2.mergeOverlay(existing.settings, variant.settings)
                  if (variant.headers !== undefined)
                    existing.headers = ProviderV2.mergeHeaders(existing.headers, variant.headers)
                  if (variant.body !== undefined) existing.body = ProviderV2.mergeOverlay(existing.body, variant.body)
                }
              }
              if (config.cost !== undefined) {
                model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
                  tier: cost.tier && { ...cost.tier },
                  input: cost.input,
                  output: cost.output,
                  cache: {
                    read: cost.cache?.read ?? Money.USDPerMillionTokens.zero,
                    write: cost.cache?.write ?? Money.USDPerMillionTokens.zero,
                  },
                }))
              }
              if (config.disabled !== undefined) model.enabled = !config.disabled
              if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
            })
          }
        }
      }
    })
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() =>
        config.entries().pipe(
          Effect.tap((entries) =>
            discover(entries).pipe(
              Effect.tap((discovered) =>
                Effect.sync(() => {
                  loaded.entries = entries
                  loaded.discovered = discovered
                }),
              ),
            ),
          ),
          Effect.andThen(ctx.integration.reload()),
          Effect.andThen(ctx.catalog.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
