export * as Catalog from "./catalog"

import { makeLocationNode } from "./effect/app-node"
import { Array, Context, Effect, Layer, Option, Order, pipe } from "effect"
import { Catalog } from "@ycoding-ai/schema/catalog"
import { CatalogModel } from "./model"
import { Provider } from "./provider"
import { EventRuntime } from "./event"
import { Policy } from "./policy"
import { State } from "./state"
import { Integration } from "./integration"

export type ProviderRecord = {
  provider: Provider.MutableInfo
  models: Map<CatalogModel.ID, CatalogModel.MutableInfo>
}

export type DefaultModel = { providerID: Provider.ID; modelID: CatalogModel.ID }

export const Event = Catalog.Event

type Data = {
  providers: Map<Provider.ID, ProviderRecord>
  defaultModel?: DefaultModel
}

export type Draft = {
  provider: {
    list: () => readonly ProviderRecord[]
    get: (providerID: Provider.ID) => ProviderRecord | undefined
    update: (providerID: Provider.ID, fn: (provider: Provider.MutableInfo) => void) => void
    remove: (providerID: Provider.ID) => void
  }
  model: {
    get: (providerID: Provider.ID, modelID: CatalogModel.ID) => CatalogModel.Info | undefined
    update: (providerID: Provider.ID, modelID: CatalogModel.ID, fn: (model: CatalogModel.MutableInfo) => void) => void
    remove: (providerID: Provider.ID, modelID: CatalogModel.ID) => void
    default: {
      get: () => DefaultModel | undefined
      set: (providerID: Provider.ID, modelID: CatalogModel.ID) => void
    }
  }
}

export interface Interface extends State.Transformable<Draft> {
  readonly provider: {
    readonly get: (providerID: Provider.ID) => Effect.Effect<Provider.Info | undefined>
    readonly all: () => Effect.Effect<Provider.Info[]>
    readonly available: () => Effect.Effect<Provider.Info[]>
  }
  readonly model: {
    readonly get: (providerID: Provider.ID, modelID: CatalogModel.ID) => Effect.Effect<CatalogModel.Info | undefined>
    readonly all: () => Effect.Effect<CatalogModel.Info[]>
    readonly available: () => Effect.Effect<CatalogModel.Info[]>
    readonly default: () => Effect.Effect<CatalogModel.Info | undefined>
    readonly small: (providerID: Provider.ID) => Effect.Effect<CatalogModel.Info | undefined>
  }
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Catalog") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const integrations = yield* Integration.Service
    const policy = yield* Policy.Service

    const available = (provider: Provider.Info, integration: Integration.Info | undefined) => {
      if (provider.disabled) return false
      if (typeof provider.settings?.apiKey === "string") return true
      if (integration?.connections.length) return true
      return provider.integrationID === undefined && !integration
    }

    const projectModel = (model: CatalogModel.Info, provider: Provider.Info) => {
      return {
        ...model,
        package: model.package ?? provider.package,
        settings: Provider.mergeOverlay(provider.settings, model.settings),
        headers: Provider.mergeHeaders(provider.headers, model.headers),
        body: Provider.mergeOverlay(provider.body, model.body),
      } satisfies CatalogModel.Info
    }

    const state = State.create<Data, Draft>({
      name: "catalog",
      initial: () => ({ providers: new Map() }),
      draft: (draft) => {
        const result: Draft = {
          provider: {
            list: () => Array.fromIterable(draft.providers.values()) as ProviderRecord[],
            get: (providerID) => draft.providers.get(providerID),
            update: (providerID, fn) => {
              let current = draft.providers.get(providerID)
              if (!current) {
                current = {
                  provider: Provider.Info.empty(providerID) as Provider.MutableInfo,
                  models: new Map<CatalogModel.ID, CatalogModel.MutableInfo>(),
                }
                draft.providers.set(providerID, current)
              }
              fn(current.provider)
            },
            remove: (providerID) => {
              draft.providers.delete(providerID)
            },
          },
          model: {
            get: (providerID, modelID) => draft.providers.get(providerID)?.models.get(modelID),
            update: (providerID, modelID, fn) => {
              let record = draft.providers.get(providerID)
              if (!record) {
                record = {
                  provider: Provider.Info.empty(providerID) as Provider.MutableInfo,
                  models: new Map<CatalogModel.ID, CatalogModel.MutableInfo>(),
                }
                draft.providers.set(providerID, record)
              }
              const model =
                record.models.get(modelID) ?? (CatalogModel.Info.empty(providerID, modelID) as CatalogModel.MutableInfo)
              if (!record.models.has(modelID)) record.models.set(modelID, model)
              fn(model)
              model.id = modelID
              model.providerID = providerID
            },
            remove: (providerID, modelID) => {
              draft.providers.get(providerID)?.models.delete(modelID)
            },
            default: {
              get: () => draft.defaultModel,
              set: (providerID, modelID) => {
                draft.defaultModel = { providerID, modelID }
              },
            },
          },
        }
        return result
      },
      finalize: Effect.fn("Catalog.finalize")(function* (catalog) {
        yield* events.publish(Event.Updated, {})
      }),
    })
    const result: Interface = {
      transform: state.transform,
      reload: state.reload,

      provider: {
        get: Effect.fn("Catalog.provider.get")(function* (providerID) {
          return state.get().providers.get(providerID)?.provider
        }),

        all: Effect.fn("Catalog.provider.all")(function* () {
          return Array.fromIterable(state.get().providers.values()).map((record) => record.provider)
        }),

        available: Effect.fn("Catalog.provider.available")(function* () {
          const active = new Map((yield* integrations.list()).map((integration) => [integration.id, integration]))
          const permitted = yield* Effect.forEach(yield* result.provider.all(), (provider) =>
            policy
              .evaluate("provider.use", provider.id, "allow")
              .pipe(Effect.map((effect) => (effect === "deny" ? undefined : provider))),
          )
          return permitted
            .filter((provider): provider is Provider.Info => provider !== undefined)
            .filter((provider) =>
              available(provider, active.get(provider.integrationID ?? Integration.ID.make(provider.id))),
            )
        }),
      },

      model: {
        get: Effect.fn("Catalog.model.get")(function* (providerID, modelID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const model = record.models.get(modelID)
          return model && projectModel(model, record.provider)
        }),

        all: Effect.fn("Catalog.model.all")(function* () {
          return pipe(
            Array.fromIterable(state.get().providers.values()),
            Array.flatMap((record) => {
              return Array.fromIterable(record.models.values()).map((model) => projectModel(model, record.provider))
            }),
            Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
          )
        }),

        available: Effect.fn("Catalog.model.available")(function* () {
          const providers = new Set((yield* result.provider.available()).map((provider) => provider.id))
          const models: CatalogModel.Info[] = []
          for (const record of state.get().providers.values()) {
            if (!providers.has(record.provider.id)) continue
            for (const model of record.models.values()) {
              if (!model.enabled) continue
              models.push(projectModel(model, record.provider))
            }
          }
          return pipe(
            models,
            Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
          )
        }),

        default: Effect.fn("Catalog.model.default")(function* () {
          const defaultModel = state.get().defaultModel
          if (defaultModel) {
            const provider = yield* result.provider.get(defaultModel.providerID)
            if (provider && (yield* result.provider.available()).some((item) => item.id === provider.id)) {
              const model = yield* result.model.get(defaultModel.providerID, defaultModel.modelID)
              if (model?.enabled) return model
            }
          }

          return (yield* result.model.available())[0]
        }),

        small: Effect.fn("Catalog.model.small")(function* (providerID) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const provider = record.provider

          // TODO: Remove these provider-specific assumptions once model syncing reliably reports available deployments.
          if (providerID === Provider.ID.azure || providerID === Provider.ID.make("azure-cognitive-services")) {
            return
          }

          if (providerID === Provider.ID.opencode) {
            const gpt5Nano = record.models.get(CatalogModel.ID.make("gpt-5-nano"))
            if (gpt5Nano?.enabled && gpt5Nano.status === "active") return projectModel(gpt5Nano, provider)
          }

          const candidates = pipe(
            Array.fromIterable(record.models.values()),
            Array.filter(
              (model) =>
                model.providerID === providerID &&
                model.enabled &&
                model.status === "active" &&
                model.capabilities.input.some((item) => item.startsWith("text")) &&
                model.capabilities.output.some((item) => item.startsWith("text")),
            ),
            Array.map((model) => ({
              model,
              priced: model.cost.length > 0,
              cost: model.cost[0] ? model.cost[0].input + model.cost[0].output : 999,
              age: (Date.now() - model.time.released) / (1000 * 60 * 60 * 24 * 30),
              small: SMALL_MODEL_RE.test(`${model.id} ${model.family ?? ""} ${model.name}`.toLowerCase()),
            })),
            Array.filter((item) => item.priced && (item.model.time.released === 0 || item.age <= 18)),
          )

          const pick = (items: typeof candidates) => {
            const maxCost = Math.max(...items.map((item) => item.cost), 0.01)
            const maxAge = Math.max(...items.map((item) => item.age), 0.01)
            return pipe(
              items,
              Array.sortWith((item) => (item.cost / maxCost) * 0.8 + (item.age / maxAge) * 0.2, Order.Number),
              Array.map((item) => projectModel(item.model, provider)),
              Array.head,
            )
          }

          return Option.getOrUndefined(
            pipe(
              candidates,
              Array.filter((item) => item.small),
              (items) => (items.length > 0 ? pick(items) : pick(candidates)),
            ),
          )
        }),
      },
    }

    return Service.of(result)
  }),
)

const SMALL_MODEL_RE = /\b(nano|flash|lite|mini|haiku|small|fast)\b/

export const node = makeLocationNode({ service: Service, layer, deps: [EventRuntime.node, Integration.node, Policy.node] })
