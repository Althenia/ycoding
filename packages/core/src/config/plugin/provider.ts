export * as ConfigProviderPlugin from "./provider"

import { define } from "../../plugin/catalog-host"
import { Money } from "@ycoding-ai/schema/money"
import { Effect, Stream } from "effect"
import { Config } from "../../config"
import { Catalog } from "../../catalog"
import { Credential } from "../../credential"
import { Integration } from "../../integration"
import type { DeepMutable } from "../../schema"
import { CatalogModel } from "../../model"
import { Provider } from "../../provider"
import { ProviderModelDiscovery } from "./provider-discovery"

const discover = Effect.fn("ConfigProviderPlugin.discover")(function* (
  entries: readonly Config.Entry[],
  integrations: Integration.Interface,
  credentials: Credential.Interface,
  catalog: Catalog.Interface,
  discovery: ProviderModelDiscovery.Interface,
  refresh: boolean,
  selectedID?: Integration.ID,
) {
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
  const result = new Map<
    string,
    Array<{ readonly snapshot?: Integration.Snapshot; readonly models: readonly ProviderModelDiscovery.Model[] }>
  >()
  yield* Effect.forEach(
    [...configured.entries()].filter(([, provider]) => provider.source === "openai-models"),
    ([id, provider]) =>
      Effect.gen(function* () {
        const definition = yield* catalog.provider.get(Provider.ID.make(id))
        const integrationID = definition?.integrationID ?? Integration.ID.make(id)
        if (selectedID !== undefined && selectedID !== integrationID) return
        const saved = yield* credentials.list(integrationID)
        const active = saved.length === 0 ? yield* integrations.connection.active(integrationID) : undefined
        const connections =
          saved.length > 0
            ? saved.map((credential) => ({
                type: "credential" as const,
                id: credential.id,
                label: credential.label,
                active: credential.active,
              }))
            : [active]
        const scopes = yield* Effect.forEach(
          connections,
          (connection) =>
            Effect.gen(function* () {
              const snapshot = connection ? yield* integrations.connection.snapshot(connection) : undefined
              if (connection?.type === "credential" && !snapshot?.credential) return { snapshot, models: [] }
              const credential = snapshot?.value
              const managed = connection?.type === "credential"
              const headers = new Headers(provider.headers)
              const apiKey = provider.settings.apiKey
              const selectedKey = credential?.type === "key" ? credential.key : credential?.access
              if (selectedKey !== undefined) headers.set("authorization", `Bearer ${selectedKey}`)
              else if (!headers.has("authorization") && typeof apiKey === "string" && apiKey)
                headers.set("authorization", `Bearer ${apiKey}`)
              const models = yield* discovery.models(
                {
                  providerID: id,
                  baseURL: provider.settings.baseURL,
                  headers: [...headers.entries()],
                  managed,
                },
                { refresh },
              )
              const current = snapshot?.credential ? yield* credentials.get(snapshot.credential.id) : undefined
              return {
                snapshot,
                models:
                  snapshot?.credential &&
                  (!current || current.accountGeneration !== snapshot.credential.accountGeneration)
                    ? []
                    : models,
              }
            }).pipe(Effect.catch(() => Effect.succeed({ models: [] as readonly ProviderModelDiscovery.Model[] }))),
          { concurrency: "unbounded" },
        )
        result.set(id, scopes)
      }).pipe(
        Effect.catch(() => Effect.logWarning("OpenAI model discovery failed", { providerID: id }).pipe(Effect.asVoid)),
      ),
    { discard: true },
  )
  return result
})

export const Plugin = define({
  id: "ycoding.config.provider",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const catalogService = yield* Catalog.Service
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const discovery = yield* ProviderModelDiscovery.Service
    const initial = yield* config.entries()
    const loaded = {
      entries: initial,
      discovered: new Map<
        string,
        Array<{ readonly snapshot?: Integration.Snapshot; readonly models: readonly ProviderModelDiscovery.Model[] }>
      >(),
    }
    yield* ctx.integration.transform((integrations) => {
      const files = loaded.entries.filter((entry): entry is Config.Document => entry.type === "document")
      const packages = new Map(
        files.flatMap((file) =>
          Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
            provider.package === undefined ? [] : [[id, provider.package] as const],
          ),
        ),
      )
      const compatible = new Set(
        [...packages].flatMap(([id, name]) =>
          name === "aisdk:@ai-sdk/openai-compatible" || name === "@ycoding-ai/ai/providers/runpod" ? [id] : [],
        ),
      )
      const configuredIntegrations = new Set([
        ...compatible,
        ...files.flatMap((file) =>
          Object.entries(file.info.providers ?? {}).flatMap(([id, provider]) =>
            provider.env === undefined ? [] : [id],
          ),
        ),
      ])
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
          if (compatible.has(id) && !integrations.method.list(integrationID).some((method) => method.type === "key")) {
            integrations.method.update({ integrationID, method: { type: "key", label: "API key" } })
          }
        }
      }
    })

    loaded.discovered = yield* discover(initial, integrations, credentials, catalogService, discovery, false)
    yield* catalogService.transform((catalog) => {
      const base = new Map(
        catalog.provider.list().map((record) => [record.provider.id, structuredClone(record.models)]),
      )
      const files = loaded.entries.filter((entry): entry is Config.Document => entry.type === "document")
      const configuredDefault = Config.latest(loaded.entries, "model")
      if (configuredDefault !== undefined)
        catalog.model.default.set(configuredDefault.providerID, configuredDefault.model, {
          variant: configuredDefault.variant,
          profile: configuredDefault.profile,
        })
      for (const [id, scopes] of loaded.discovered) {
        const providerID = Provider.ID.make(id)
        const models = scopes.flatMap((scope) => scope.models)
        for (const discovered of models) {
          catalog.model.update(providerID, CatalogModel.ID.make(discovered.id), (model) =>
            applyDiscovered(catalog, providerID, model, discovered),
          )
        }
      }
      for (const file of files) {
        for (const [id, item] of Object.entries(file.info.providers ?? {})) {
          const providerID = Provider.ID.make(id)
          catalog.provider.update(providerID, (provider) => {
            if (item.name !== undefined) provider.name = item.name
            if (item.package !== undefined) provider.package = item.package
            if (item.settings !== undefined)
              provider.settings = mutable(Provider.mergeOverlay(provider.settings, item.settings))
            if (item.headers !== undefined) provider.headers = Provider.mergeHeaders(provider.headers, item.headers)
            if (item.body !== undefined) provider.body = mutable(Provider.mergeOverlay(provider.body, item.body))
          })
          for (const [id, config] of Object.entries(item.models ?? {})) {
            catalog.model.update(providerID, CatalogModel.ID.make(id), (model) => applyModelConfig(model, config))
          }
        }
      }
      for (const id of new Set(files.flatMap((file) => Object.keys(file.info.providers ?? {})))) {
        catalog.model.account.configure(Provider.ID.make(id), (model) => {
          for (const file of files) {
            const item = file.info.providers?.[id]
            if (!item) continue
            if (item.package !== undefined) model.package = item.package
            if (item.settings !== undefined)
              model.settings = mutable(Provider.mergeOverlay(model.settings, item.settings))
            if (item.headers !== undefined) model.headers = Provider.mergeHeaders(model.headers, item.headers)
            if (item.body !== undefined) model.body = mutable(Provider.mergeOverlay(model.body, item.body))
          }
          for (const file of files) {
            const config = file.info.providers?.[id]?.models?.[model.id]
            if (config) applyModelConfig(model, config)
          }
        })
      }
      for (const [id, scopes] of loaded.discovered) {
        const providerID = Provider.ID.make(id)
        const provider = catalog.provider.get(providerID)?.provider
        if (!provider) continue
        catalog.model.account.clear(providerID)
        const configuredIDs = files.flatMap((file) => Object.keys(file.info.providers?.[id]?.models ?? {}))
        for (const scope of scopes) {
          if (!scope.snapshot?.credential) continue
          const models = [...new Set([...scope.models.map((model) => model.id), ...configuredIDs])].map((id) => {
            const modelID = CatalogModel.ID.make(id)
            const model: CatalogModel.MutableInfo = mutable(
              base.get(providerID)?.get(modelID) ?? CatalogModel.Info.empty(providerID, modelID),
            )
            const discovered = scope.models.find((model) => model.id === id)
            if (discovered) applyDiscovered(catalog, providerID, model, discovered)
            for (const file of files) {
              const config = file.info.providers?.[providerID]?.models?.[id]
              if (config) applyModelConfig(model, config)
            }
            return {
              ...model,
              package: model.package ?? provider.package,
              settings: Provider.mergeOverlay(provider.settings, model.settings),
              headers: Provider.mergeHeaders(provider.headers, model.headers),
              body: Provider.mergeOverlay(provider.body, model.body),
            }
          })
          catalog.model.account.update(scope.snapshot.credential, providerID, models)
        }
      }
    })
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated" || event.type === "integration.connection.updated"),
      Stream.runForEach((event) =>
        event.type === "integration.connection.updated"
          ? discover(
              loaded.entries,
              integrations,
              credentials,
              catalogService,
              discovery,
              true,
              Integration.ID.make(event.data.integrationID),
            ).pipe(
              Effect.tap((discovered) =>
                Effect.sync(() => {
                  for (const [providerID, scopes] of discovered) loaded.discovered.set(providerID, scopes)
                }),
              ),
              Effect.andThen(ctx.catalog.reload()),
            )
          : config.entries().pipe(
              Effect.tap((entries) =>
                Effect.sync(() => {
                  loaded.entries = entries
                }).pipe(
                  Effect.andThen(ctx.integration.reload()),
                  Effect.andThen(discover(entries, integrations, credentials, catalogService, discovery, true)),
                  Effect.tap((discovered) =>
                    Effect.sync(() => {
                      loaded.entries = entries
                      loaded.discovered = discovered
                    }),
                  ),
                ),
              ),
              Effect.andThen(ctx.catalog.reload()),
            ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>
}

function applyDiscovered(
  catalog: Catalog.Draft,
  providerID: Provider.ID,
  model: CatalogModel.MutableInfo,
  discovered: ProviderModelDiscovery.Model,
) {
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
    candidates.find((candidate) => candidate.providerID === Provider.ID.openrouter)?.model ??
    candidates.find((candidate) => candidate.providerID === Provider.ID.openai)?.model ??
    candidates[0]?.model
  model.modelID = CatalogModel.ID.make(discovered.id)
  if (discovered.name) model.name = discovered.name
  if (source?.family) model.family = source.family
  if (source?.limit) model.limit = { ...source.limit }
  if (discovered.limit) model.limit = { ...model.limit, ...discovered.limit }
  if (source?.cost) model.cost = source.cost.map((cost) => ({ ...cost, cache: { ...cost.cache } }))
  model.capabilities = {
    tools: discovered.capabilities?.tools ?? source?.capabilities.tools ?? false,
    input: [...(discovered.capabilities?.input ?? source?.capabilities.input ?? ["text"])],
    output: [...(discovered.capabilities?.output ?? source?.capabilities.output ?? ["text"])],
  }
  if (discovered.variants)
    model.variants = discovered.variants.map((variant) => ({
      id: CatalogModel.VariantID.make(variant.id),
      settings: mutable(Provider.mergeOverlay(undefined, variant.settings)),
      headers: variant.headers && { ...variant.headers },
      body: mutable(Provider.mergeOverlay(undefined, variant.body)),
    }))
}

type ConfiguredModel = NonNullable<NonNullable<Config.Info["providers"]>[string]["models"]>[string]

function applyModelConfig(model: CatalogModel.MutableInfo, config: ConfiguredModel) {
  if (config.family !== undefined) model.family = config.family
  if (config.name !== undefined) model.name = config.name
  if (config.modelID !== undefined) model.modelID = config.modelID
  if (config.api !== undefined) model.api = config.api
  if (config.package !== undefined) model.package = config.package
  if (config.settings !== undefined) model.settings = mutable(Provider.mergeOverlay(model.settings, config.settings))
  if (config.headers !== undefined) model.headers = Provider.mergeHeaders(model.headers, config.headers)
  if (config.body !== undefined) model.body = mutable(Provider.mergeOverlay(model.body, config.body))
  if (config.capabilities?.tools !== undefined) model.capabilities.tools = config.capabilities.tools
  if (config.capabilities?.input !== undefined) model.capabilities.input = [...config.capabilities.input]
  if (config.capabilities?.output !== undefined) model.capabilities.output = [...config.capabilities.output]
  for (const variant of config.variants ?? []) {
    model.variants ??= []
    let existing = model.variants.find((item) => item.id === variant.id)
    if (!existing) {
      existing = { id: variant.id }
      model.variants.push(existing)
    }
    if (variant.settings !== undefined)
      existing.settings = mutable(Provider.mergeOverlay(existing.settings, variant.settings))
    if (variant.headers !== undefined) existing.headers = Provider.mergeHeaders(existing.headers, variant.headers)
    if (variant.body !== undefined) existing.body = mutable(Provider.mergeOverlay(existing.body, variant.body))
  }
  if (config.cost !== undefined)
    model.cost = (Array.isArray(config.cost) ? config.cost : [config.cost]).map((cost) => ({
      tier: cost.tier && { ...cost.tier },
      input: cost.input,
      output: cost.output,
      cache: {
        read: cost.cache?.read ?? Money.USDPerMillionTokens.zero,
        write: cost.cache?.write ?? Money.USDPerMillionTokens.zero,
      },
    }))
  if (config.disabled !== undefined) model.enabled = !config.disabled
  if (config.limit !== undefined) model.limit = { ...model.limit, ...config.limit }
}
