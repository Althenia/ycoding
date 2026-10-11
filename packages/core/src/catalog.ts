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
import { Credential } from "./credential"

export type ProviderRecord = {
  provider: Provider.MutableInfo
  models: Map<CatalogModel.ID, CatalogModel.MutableInfo>
}

export type DefaultModel = {
  providerID: Provider.ID
  modelID: CatalogModel.ID
  variant?: CatalogModel.VariantID
  profile?: string
}

export const Event = Catalog.Event

type Data = {
  providers: Map<Provider.ID, ProviderRecord>
  defaultModel?: DefaultModel
  accounts: Map<
    Credential.ID,
    { generation: number; providers: Map<Provider.ID, Map<CatalogModel.ID, CatalogModel.Info>> }
  >
  contextualProviders: Set<Provider.ID>
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
    account: {
      update: (credential: Credential.Info, providerID: Provider.ID, models: readonly CatalogModel.Info[]) => void
      clear: (providerID: Provider.ID) => void
      configure: (providerID: Provider.ID, update: (model: CatalogModel.MutableInfo) => void) => void
    }
    default: {
      get: () => DefaultModel | undefined
      set: (
        providerID: Provider.ID,
        modelID: CatalogModel.ID,
        selection?: Pick<CatalogModel.Ref, "variant" | "profile">,
      ) => void
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
    readonly get: (
      providerID: Provider.ID,
      modelID: CatalogModel.ID,
      profile?: string,
    ) => Effect.Effect<CatalogModel.Info | undefined>
    readonly all: () => Effect.Effect<CatalogModel.Info[]>
    readonly available: () => Effect.Effect<CatalogModel.Info[]>
    readonly default: () => Effect.Effect<CatalogModel.Info | undefined>
    readonly defaultSelection: () => Effect.Effect<CatalogModel.Ref | undefined>
    readonly forConnection: (
      model: CatalogModel.Info,
      snapshot?: Integration.Snapshot,
    ) => Effect.Effect<CatalogModel.Info | undefined>
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
    const credentials = yield* Credential.Service

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
      initial: () => ({ providers: new Map(), accounts: new Map(), contextualProviders: new Set() }),
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
            account: {
              configure: (providerID, update) => {
                for (const account of draft.accounts.values()) {
                  const models = account.providers.get(providerID)
                  if (!models) continue
                  for (const [id, model] of models) {
                    const configured = structuredClone(model) as CatalogModel.MutableInfo
                    update(configured)
                    models.set(id, configured)
                  }
                }
              },
              update: (credential, providerID, models) => {
                draft.contextualProviders.add(providerID)
                const existing = draft.accounts.get(credential.id)
                const entry =
                  existing?.generation === credential.accountGeneration
                    ? existing
                    : { generation: credential.accountGeneration, providers: new Map() }
                entry.providers.set(providerID, new Map(models.map((model) => [model.id, structuredClone(model)])))
                draft.accounts.set(credential.id, entry)
              },
              clear: (providerID) => {
                draft.contextualProviders.add(providerID)
                for (const account of draft.accounts.values()) account.providers.delete(providerID)
              },
            },
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
              set: (providerID, modelID, selection) => {
                draft.defaultModel = { providerID, modelID, ...selection }
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
    const accountModels = (credential: Credential.Info, providerID: Provider.ID) => {
      const account = state.get().accounts.get(credential.id)
      return account?.generation === credential.accountGeneration ? account.providers.get(providerID) : undefined
    }
    const profiled = (
      model: CatalogModel.Info,
      provider: Provider.Info,
      saved: readonly Credential.Info[],
      selectedCredential?: Credential.Info,
    ) => {
      const relevant = saved.filter(
        (credential) => credential.integrationID === (provider.integrationID ?? Integration.ID.make(provider.id)),
      )
      const active = relevant.find((credential) => credential.active) ?? relevant.at(-1)
      const contextual = state.get().contextualProviders.has(provider.id)
      const effective = selectedCredential ?? active
      const selected = effective ? accountModels(effective, provider.id)?.get(model.id) : undefined
      return {
        ...(selected ?? model),
        enabled: contextual && effective ? selected?.enabled === true : model.enabled,
        profiles: relevant
          .filter(
            (credential) =>
              relevant.filter((item) => item.label === credential.label).length === 1 &&
              (contextual ? accountModels(credential, provider.id)?.get(model.id)?.enabled === true : model.enabled),
          )
          .map((credential) => {
            const daybreak = accountModels(credential, provider.id)?.get(model.id)?.daybreak
            const variants =
              (contextual ? accountModels(credential, provider.id)?.get(model.id)?.variants : model.variants)?.map(
                (variant) => variant.id,
              ) ?? []
            return {
              name: credential.label,
              active: credential.id === active?.id,
              variants,
              ...(daybreak?.length ? { daybreak: [...daybreak] } : {}),
            }
          }),
      }
    }
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
        defaultSelection: Effect.fn("Catalog.model.defaultSelection")(function* () {
          const configured = state.get().defaultModel
          if (configured?.profile !== undefined)
            return CatalogModel.Ref.make({
              providerID: configured.providerID,
              id: configured.modelID,
              variant: configured.variant,
              profile: configured.profile,
            })
          const model = yield* result.model.default()
          return model
            ? CatalogModel.Ref.make({
                providerID: model.providerID,
                id: model.id,
                variant:
                  configured?.providerID === model.providerID && configured.modelID === model.id
                    ? configured.variant
                    : undefined,
              })
            : undefined
        }),
        forConnection: Effect.fn("Catalog.model.forConnection")(function* (model, snapshot) {
          const provider = yield* result.provider.get(model.providerID)
          if (provider?.disabled || (yield* policy.evaluate("provider.use", model.providerID, "allow")) === "deny")
            return undefined
          const credential = snapshot?.credential
          const models = credential ? accountModels(credential, model.providerID) : undefined
          if (credential && state.get().contextualProviders.has(model.providerID) && models === undefined)
            return undefined
          const selected = models ? models.get(model.id) : model
          if (!selected?.enabled) return undefined
          return models ? selected : provider ? projectModel(selected, provider) : selected
        }),
        get: Effect.fn("Catalog.model.get")(function* (providerID, modelID, profile) {
          const record = state.get().providers.get(providerID)
          if (!record) return
          const saved = yield* credentials.all()
          const model =
            record.models.get(modelID) ??
            saved.flatMap((credential) => {
              const model = accountModels(credential, providerID)?.get(modelID)
              return model ? [model] : []
            })[0]
          if (profile === undefined)
            return model && profiled(projectModel(model, record.provider), record.provider, saved)
          const matching = saved.filter(
            (credential) =>
              credential.integrationID === (record.provider.integrationID ?? Integration.ID.make(providerID)) &&
              credential.label === profile,
          )
          if (matching.length !== 1) return undefined
          const contextual = state.get().contextualProviders.has(providerID)
            ? accountModels(matching[0]!, providerID)?.get(modelID)
            : model
              ? projectModel(model, record.provider)
              : undefined
          return contextual && profiled(contextual, record.provider, saved, matching[0])
        }),

        all: Effect.fn("Catalog.model.all")(function* () {
          const saved = yield* credentials.all()
          return pipe(
            Array.fromIterable(state.get().providers.values()),
            Array.flatMap((record) => {
              const models = new Map(record.models)
              for (const credential of saved)
                for (const model of accountModels(credential, record.provider.id)?.values() ?? [])
                  if (!models.has(model.id)) models.set(model.id, model as CatalogModel.MutableInfo)
              return Array.fromIterable(models.values()).map((model) =>
                profiled(projectModel(model, record.provider), record.provider, saved),
              )
            }),
            Array.sortWith((item) => item.time.released, Order.flip(Order.Number)),
          )
        }),

        available: Effect.fn("Catalog.model.available")(function* () {
          const providers = new Set((yield* result.provider.available()).map((provider) => provider.id))
          const models = (yield* result.model.all()).filter(
            (model) => providers.has(model.providerID) && (model.enabled || model.profiles?.length),
          )
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
              const model = yield* result.model.get(defaultModel.providerID, defaultModel.modelID, defaultModel.profile)
              if (
                model &&
                (defaultModel.profile === undefined
                  ? model.enabled
                  : model.profiles?.some((profile) => profile.name === defaultModel.profile))
              )
                return model
            }
            if (defaultModel.profile !== undefined) return undefined
          }

          return (yield* result.model.available()).find((model) => model.enabled)
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

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [EventRuntime.node, Integration.node, Policy.node, Credential.node],
})
