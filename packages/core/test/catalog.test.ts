import { describe, expect } from "bun:test"
import { Money } from "@ycoding-ai/schema/money"
import { DateTime, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { ConfigProviderPlugin } from "@ycoding-ai/core/config/plugin/provider"
import { Integration } from "@ycoding-ai/core/integration"
import { Credential } from "@ycoding-ai/core/credential"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { Session } from "@ycoding-ai/core/session"
import { Project } from "@ycoding-ai/core/project"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("test") })),
)
const catalogLayer = AppNodeBuilder.build(
  LayerNode.group([Catalog.node, EventRuntime.node, Credential.node, Integration.node]),
  [[Location.node, locationLayer]],
)
const it = testEffect(catalogLayer)

describe("Catalog", () => {
  it.effect("keeps retired catalog and integration registrations out without deleting saved credentials", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      const credentials = yield* Credential.Service
      const retired = Provider.ID.make("AntiGravity")
      const integrationID = Integration.ID.make(retired)
      const allowed = Provider.ID.make("fixture-compatible")
      const modelID = CatalogModel.ID.make("fixture")
      const credential = yield* credentials.create({
        integrationID,
        label: "saved",
        value: Credential.Key.make({ type: "key", key: "fixture-key" }),
      })
      yield* integrations.transform((draft) => draft.method.update({ integrationID, method: { type: "key" } }))
      yield* catalog.transform((draft) => {
        draft.provider.update(retired, (provider) => { provider.name = "Retired" })
        draft.model.update(retired, modelID, (model) => { model.enabled = true })
        draft.model.update(allowed, modelID, (model) => { model.enabled = true })
        draft.model.account.update(credential, allowed, [CatalogModel.Info.empty(allowed, CatalogModel.ID.make("retired-account"))])
      })

      expect((yield* catalog.provider.all()).map((provider) => provider.id)).toEqual([allowed])
      expect(yield* catalog.model.get(retired, modelID)).toBeUndefined()
      expect(yield* integrations.get(integrationID)).toBeUndefined()
      expect(yield* integrations.connection.active(integrationID)).toBeUndefined()
      expect(yield* catalog.model.get(allowed, CatalogModel.ID.make("retired-account"))).toBeUndefined()
      expect((yield* credentials.list(integrationID)).map((item) => item.id)).toEqual([credential.id])
    }),
  )

  for (const profile of [undefined, "saved"] as const) {
    it.effect(`rejects a configured retired default ${profile === undefined ? "without" : "with"} a profile`, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const retired = "MuSe"
        const allowed = Provider.ID.make("fixture-compatible")
        const definition = {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { apiKey: "fixture-key", baseURL: "https://fixture.invalid/v1" },
          models: { fixture: {} },
        }
        const parsed = yield* Config.parseDocument(JSON.stringify({
          model: { providerID: retired, model: "fixture", profile },
          providers: { [retired]: definition, [allowed]: definition },
        }), "fixture.json")
        const entries = [new Config.Document({ type: "document", info: required(parsed.info) })]
        yield* integrations.transform((draft) => ConfigProviderPlugin.applyIntegrations(draft, entries))
        yield* catalog.transform((draft) => ConfigProviderPlugin.applyConfigured(draft, entries))
        const session = Session.Info.make({
          id: Session.ID.make("ses_retired_default"),
          projectID: Project.ID.global,
          scope: "bound",
          title: "Fixture",
          cost: Money.USD.zero,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
          location: { directory: AbsolutePath.make("/fixture") },
        })
        const message = yield* SessionRunnerModel.selection(session, catalog.model).pipe(
          Effect.match({ onFailure: (error) => error.message, onSuccess: () => undefined }),
        )

        expect(message).toBe("Provider no longer supported: MuSe")
        expect(yield* catalog.model.default()).toBeUndefined()
        expect((yield* catalog.model.available()).map((model) => model.providerID)).toEqual([allowed])
        expect(yield* integrations.get(Integration.ID.make(retired))).toBeUndefined()
      }),
    )
  }

  it.effect("publishes an updated event after catalog changes", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const events = yield* EventRuntime.Service
      const updated = yield* events
        .subscribe(Catalog.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* catalog.transform((editor) => editor.provider.update(Provider.ID.make("test"), () => {}))

      expect((yield* Fiber.join(updated)).length).toBe(1)
    }),
  )

  it.effect("derives availability from active credentials without changing provider state", () => {
    const integrationID = Integration.ID.make("test")
    const localCatalogLayer = Layer.fresh(
      AppNodeBuilder.build(LayerNode.group([Catalog.node, Credential.node]), [[Location.node, locationLayer]]),
    )

    return Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const credentials = yield* Credential.Service
      yield* catalog.transform((editor) => editor.provider.update(Provider.ID.make("test"), () => {}))
      yield* credentials.create({
        integrationID,
        label: "First",
        value: Credential.Key.make({ type: "key", key: "first", metadata: { tenant: "one" } }),
      })

      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([Provider.ID.make("test")])
      expect(required(yield* catalog.provider.get(Provider.ID.make("test"))).body).toBeUndefined()
      yield* credentials.create({
        integrationID,
        label: "Second",
        value: Credential.Key.make({ type: "key", key: "second", metadata: { tenant: "two" } }),
      })
      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([Provider.ID.make("test")])
      expect(required(yield* catalog.provider.get(Provider.ID.make("test"))).body).toBeUndefined()
    }).pipe(Effect.provide(localCatalogLayer))
  })

  it.effect("derives availability from a provider's integration", () => {
    const integrationID = Integration.ID.make("gateway")
    const providerID = Provider.ID.make("remote")
    const localCatalogLayer = Layer.fresh(
      AppNodeBuilder.build(LayerNode.group([Catalog.node, Credential.node, Integration.node]), [
        [Location.node, locationLayer],
      ]),
    )

    return Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* (yield* Integration.Service).transform((editor) => editor.update(integrationID, () => {}))
      yield* catalog.transform((editor) =>
        editor.provider.update(providerID, (provider) => {
          provider.integrationID = integrationID
        }),
      )
      expect(yield* catalog.provider.available()).toEqual([])

      yield* (yield* Credential.Service).create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect((yield* catalog.provider.available()).map((provider) => provider.id)).toEqual([providerID])
    }).pipe(Effect.provide(localCatalogLayer))
  })

  it.effect("projects environment connections without a catalog plugin", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.CATALOG_TEST_API_KEY
        process.env.CATALOG_TEST_API_KEY = "secret"
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          const providerID = Provider.ID.make("test")
          yield* integrations.transform((editor) =>
            editor.method.update({
              integrationID: Integration.ID.make(providerID),
              method: { type: "env", names: ["CATALOG_TEST_API_KEY"] },
            }),
          )
          yield* catalog.transform((editor) => editor.provider.update(providerID, () => {}))

          expect((yield* catalog.provider.available()).map((provider) => provider.id)).toContain(providerID)
        }),
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CATALOG_TEST_API_KEY
          else process.env.CATALOG_TEST_API_KEY = previous
        }),
    ),
  )

  it.effect("stores provider package settings", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      yield* catalog.transform((catalog) =>
        catalog.provider.update(providerID, (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://override.example.com" }
        }),
      )

      expect(required(yield* catalog.provider.get(providerID))).toMatchObject({
        package: Provider.aisdk("@ai-sdk/openai-compatible"),
        settings: { baseURL: "https://override.example.com" },
      })
    }),
  )

  it.effect("uses model package settings over provider settings", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const modelID = CatalogModel.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://provider.example.com" }
        })
        catalog.model.update(providerID, modelID, (model) => {
          model.modelID = CatalogModel.ID.make("upstream-model")
          model.package = Provider.aisdk("@ai-sdk/openai-compatible")
          model.settings = { baseURL: "https://override.example.com" }
        })
      })

      expect(required(yield* catalog.model.get(providerID, modelID))).toMatchObject({
        modelID: CatalogModel.ID.make("upstream-model"),
        package: Provider.aisdk("@ai-sdk/openai-compatible"),
        settings: { baseURL: "https://override.example.com" },
      })
    }),
  )

  it.effect("resolves default model package settings from the provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const modelID = CatalogModel.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://provider.example.com" }
        })
        catalog.model.update(providerID, modelID, () => {})
      })

      expect(required(yield* catalog.model.get(providerID, modelID))).toMatchObject({
        package: Provider.aisdk("@ai-sdk/openai-compatible"),
        settings: { baseURL: "https://provider.example.com" },
      })
    }),
  )

  it.effect("resolves provider and model overlay merges", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const modelID = CatalogModel.ID.make("model")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, (provider) => {
          provider.settings = { provider: true, shared: "provider" }
          provider.headers = { provider: "provider", shared: "provider" }
          provider.body = { provider: true, shared: "provider" }
        })
        catalog.model.update(providerID, modelID, (model) => {
          model.settings = { model: true, shared: "model" }
          model.headers = { model: "model", shared: "model" }
          model.body = { model: true, shared: "model" }
        })
      })

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.settings).toEqual({ provider: true, shared: "model", model: true })
      expect(model.headers).toEqual({ provider: "provider", shared: "model", model: "model" })
      expect(model.body).toEqual({ provider: true, shared: "model", model: true })
    }),
  )

  it.effect("falls back to newest available model when no default is configured", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, CatalogModel.ID.make("old"), (model) => {
          model.time.released = 1000
        })
        catalog.model.update(providerID, CatalogModel.ID.make("new"), (model) => {
          model.time.released = 2000
        })
      })

      expect((yield* catalog.model.default())?.id).toMatch("new")
    }),
  )

  it.effect("uses a transform-provided default model until that transform is replaced", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      const old = CatalogModel.ID.make("old")
      const newest = CatalogModel.ID.make("new")
      const models = (catalog: Catalog.Draft) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, old, (model) => {
          model.time.released = 1000
        })
        catalog.model.update(providerID, newest, (model) => {
          model.time.released = 2000
        })
      }

      let configured = true
      yield* catalog.transform((catalog) => {
        models(catalog)
        if (configured) catalog.model.default.set(providerID, old)
      })
      expect((yield* catalog.model.default())?.id).toBe(old)

      configured = false
      const reload = yield* catalog.reload().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("500 millis")
      yield* Fiber.join(reload)
      expect((yield* catalog.model.default())?.id).toBe(newest)
    }),
  )

  it.effect("ignores a configured default on a disabled provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const disabledProvider = Provider.ID.make("disabled")
      const enabledProvider = Provider.ID.make("enabled")
      const disabledModel = CatalogModel.ID.make("configured")
      const fallbackModel = CatalogModel.ID.make("fallback")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(disabledProvider, (provider) => {
          provider.disabled = true
        })
        catalog.model.update(disabledProvider, disabledModel, () => {})
        catalog.provider.update(enabledProvider, () => {})
        catalog.model.update(enabledProvider, fallbackModel, () => {})
        catalog.model.default.set(disabledProvider, disabledModel)
      })

      expect(yield* catalog.model.default()).toMatchObject({
        providerID: enabledProvider,
        id: fallbackModel,
      })
    }),
  )

  it.effect("small model considers explicit zero-cost active models", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("free-provider")
      const modelID = CatalogModel.ID.make("deepseek-v4-flash-free")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, modelID, (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [
            {
              input: Money.USDPerMillionTokens.zero,
              output: Money.USDPerMillionTokens.zero,
              cache: {
                read: Money.USDPerMillionTokens.zero,
                write: Money.USDPerMillionTokens.zero,
              },
            },
          ]
          model.time.released = Date.now()
        })
      })

      expect((yield* catalog.model.small(providerID))?.id).toBe(modelID)
    }),
  )

  it.effect("small model prefers small keyword candidates before cost scoring", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("test")
      yield* catalog.transform((catalog) => {
        catalog.provider.update(providerID, () => {})
        catalog.model.update(providerID, CatalogModel.ID.make("cheap-large"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [
            {
              input: Money.USDPerMillionTokens.make(1),
              output: Money.USDPerMillionTokens.make(1),
              cache: {
                read: Money.USDPerMillionTokens.zero,
                write: Money.USDPerMillionTokens.zero,
              },
            },
          ]
          model.time.released = Date.now()
        })
        catalog.model.update(providerID, CatalogModel.ID.make("expensive-mini"), (model) => {
          model.capabilities.input = ["text"]
          model.capabilities.output = ["text"]
          model.cost = [
            {
              input: Money.USDPerMillionTokens.make(10),
              output: Money.USDPerMillionTokens.make(10),
              cache: {
                read: Money.USDPerMillionTokens.zero,
                write: Money.USDPerMillionTokens.zero,
              },
            },
          ]
          model.time.released = Date.now()
        })
      })

      expect((yield* catalog.model.small(providerID))?.id).toMatch("expensive-mini")
    }),
  )
})
