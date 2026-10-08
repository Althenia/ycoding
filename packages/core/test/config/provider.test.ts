import { describe, expect } from "bun:test"
import { Money } from "@ycoding-ai/schema/money"
import { Effect, Schema } from "effect"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { ConfigProviderPlugin } from "@ycoding-ai/core/config/plugin/provider"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { CatalogModel } from "@ycoding-ai/core/model"
import { PluginRegistry } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { Provider } from "@ycoding-ai/core/provider"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { LLM, LLMClient, Message } from "@ycoding-ai/ai"
import { RequestExecutor } from "@ycoding-ai/ai/route"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { OpenAIPlugin } from "@ycoding-ai/core/plugin/provider/openai"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginRegistry.Service
  const host = yield* PluginHost.make(plugin)
  yield* ConfigProviderPlugin.Plugin.effect(host).pipe(Effect.provideService(Config.Service, config))
})

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value")
  return value
}

function withEnv<A, E, R>(vars: Record<string, string | undefined>, effect: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
      Object.entries(vars).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
      return previous
    }),
    effect,
    (previous) =>
      Effect.sync(() =>
        Object.entries(previous).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }),
      ),
  )
}

const decode = Schema.decodeUnknownSync(Config.Info)

const waitFor = Effect.fnUntraced(function* (condition: () => Effect.Effect<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (yield* condition()) return
    yield* Effect.sleep("10 millis")
  }
  yield* Effect.die("Timed out waiting for model discovery")
})

describe("ConfigProviderPlugin.Plugin", () => {
  it.effect(
    "preserves configured native OpenAI routing after account snapshots without sending outside the mocked transport",
    () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const credentials = yield* Credential.Service
        const integrations = yield* Integration.Service
        const registry = yield* PluginRegistry.Service
        const host = yield* PluginHost.make(registry)
        const providerID = Provider.ID.openai
        const modelID = CatalogModel.ID.make("gpt-5.6")
        yield* catalog.transform((draft) => {
          draft.provider.update(providerID, (provider) => {
            provider.package = Provider.aisdk("@ai-sdk/openai")
          })
          draft.model.update(providerID, modelID, (model) => {
            model.variants = [{ id: CatalogModel.VariantID.make("high"), body: { reasoning: { effort: "high" } } }]
          })
        })
        const profiles = yield* Effect.forEach(["Work", "Personal"], (label) =>
          credentials.create({
            integrationID: Integration.ID.make(providerID),
            label,
            value: { type: "key", key: `fixture-${label}` },
          }),
        )
        yield* OpenAIPlugin.effect(host).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ models: [] }))),
            ),
          ),
        )
        yield* addPlugin(
          Config.Service.of({
            reload: () => Effect.void,
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode({
                    providers: {
                      openai: {
                        package: "@ycoding-ai/ai/providers/openai",
                        settings: {
                          baseURL: "http://127.0.0.1:45678/v1",
                          providerOptions: { openai: { store: true } },
                        },
                        headers: { "x-provider": "configured" },
                        body: { metadata: { provider: "configured" } },
                        models: {
                          [modelID]: {
                            settings: { organization: "fixture-org" },
                            headers: { "x-model": "configured" },
                            body: { metadata: { model: "configured" } },
                            limit: { context: 100000, output: 4096 },
                          },
                        },
                      },
                    },
                  }),
                }),
              ]),
          }),
        )
        const captured: {
          url: string
          authorization?: string
          headers: Readonly<Record<string, string>>
          body: unknown
        }[] = []
        yield* Effect.forEach(profiles, (profile) =>
          Effect.gen(function* () {
            const definition = required(yield* catalog.model.get(providerID, modelID, profile.label))
            const snapshot = yield* integrations.connection.snapshot({
              type: "credential",
              id: profile.id,
              label: profile.label,
              active: profile.active,
            })
            const selected = required(yield* catalog.model.forConnection(definition, snapshot))
            expect(selected.package).toBe("@ycoding-ai/ai/providers/openai")
            expect(selected.settings).toMatchObject({
              baseURL: "http://127.0.0.1:45678/v1",
              organization: "fixture-org",
              providerOptions: { openai: { store: true } },
            })
            const model = yield* SessionRunnerModel.fromCatalogModel(
              yield* SessionRunnerModel.withVariant(selected, CatalogModel.VariantID.make("high")),
              snapshot.value,
            )
            yield* LLMClient.generate(
              LLM.request({ model, messages: [Message.user("Offline endpoint regression")] }),
            ).pipe(
              Effect.provide(LLMClient.configured()),
              Effect.provideService(RequestExecutor.Service, {
                execute: (request) =>
                  Effect.sync(() => {
                    if (request.body._tag !== "Uint8Array") throw new Error("Expected encoded JSON body")
                    captured.push({
                      url: request.url,
                      authorization: request.headers.authorization,
                      headers: request.headers,
                      body: JSON.parse(new TextDecoder().decode(request.body.body)),
                    })
                    return HttpClientResponse.fromWeb(request, new Response("offline fixture", { status: 400 }))
                  }),
              }),
              Effect.exit,
            )
          }),
        )
        expect(captured.map((request) => request.url)).toEqual([
          "http://127.0.0.1:45678/v1/responses",
          "http://127.0.0.1:45678/v1/responses",
        ])
        expect(captured.map((request) => request.authorization)).toEqual([
          "Bearer fixture-Work",
          "Bearer fixture-Personal",
        ])
        for (const request of captured) {
          expect(request.headers).toMatchObject({
            "x-provider": "configured",
            "x-model": "configured",
            "openai-organization": "fixture-org",
          })
          expect(request.body).toMatchObject({
            store: true,
            metadata: { provider: "configured", model: "configured" },
            reasoning: { effort: "high" },
          })
        }
      }),
  )

  it.effect(
    "overlays explicit configuration on existing account inventories without importing another account's fields or eligibility",
    () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const credentials = yield* Credential.Service
        const integrations = yield* Integration.Service
        const providers = ["cursor", "github-copilot", "account-service", "configured-discovery"]
        const modelID = CatalogModel.ID.make("shared")
        const accounts = yield* Effect.forEach(providers, (id) =>
          Effect.gen(function* () {
            const providerID = Provider.ID.make(id)
            const profiles = yield* Effect.forEach(["Work", "Personal"], (label) =>
              credentials.create({
                integrationID: Integration.ID.make(id),
                label,
                value: { type: "key", key: `fixture-${id}-${label}` },
              }),
            )
            yield* catalog.transform((draft) => {
              draft.provider.update(providerID, (provider) => {
                provider.integrationID = Integration.ID.make(id)
                provider.package = "account-package"
              })
              draft.model.update(providerID, modelID, (model) => {
                model.settings = { privateInventory: "global-must-not-leak" }
                model.variants = [{ id: CatalogModel.VariantID.make("global-only") }]
              })
              for (const profile of profiles) {
                const work = profile.label === "Work"
                const definition = {
                  ...CatalogModel.Info.empty(providerID, modelID),
                  package: "account-package",
                  settings: { privateInventory: profile.label, nested: { retained: profile.label } },
                  headers: { "x-account": profile.label },
                  body: { nested: { retained: profile.label } },
                  variants: [
                    {
                      id: CatalogModel.VariantID.make(work ? "high" : "low"),
                      body: { nested: { variant: profile.label } },
                    },
                  ],
                }
                draft.model.account.update(profile, providerID, [
                  definition,
                  { ...definition, id: CatalogModel.ID.make(work ? "work-only" : "personal-only") },
                ])
              }
            })
            return { providerID, profiles }
          }),
        )
        yield* addPlugin(
          Config.Service.of({
            reload: () => Effect.void,
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode({
                    providers: Object.fromEntries(
                      providers.map((id) => [
                        id,
                        {
                          package: "@ycoding-ai/ai/providers/openai",
                          settings: { baseURL: "http://127.0.0.1:45678/v1", nested: { provider: "configured" } },
                          headers: { "x-provider": "configured" },
                          body: { nested: { provider: "configured" } },
                          models: {
                            shared: {
                              settings: { nested: { model: "configured", precedence: "model" } },
                              headers: { "x-precedence": "model" },
                              body: { nested: { model: "configured", precedence: "model" } },
                            },
                            "work-only": { name: "Configured Work only" },
                            inaccessible: { name: "Must not become eligible" },
                          },
                        },
                      ]),
                    ),
                  }),
                }),
                new Config.Document({
                  type: "document",
                  info: decode({
                    providers: Object.fromEntries(
                      providers.map((id) => [
                        id,
                        {
                          settings: { nested: { precedence: "later-provider" } },
                          headers: { "x-precedence": "later-provider" },
                          body: { nested: { precedence: "later-provider" } },
                        },
                      ]),
                    ),
                  }),
                }),
              ]),
          }),
        )
        for (const account of accounts) {
          for (const profile of account.profiles) {
            const selected = required(yield* catalog.model.get(account.providerID, modelID, profile.label))
            const snapshot = yield* integrations.connection.snapshot({
              type: "credential",
              id: profile.id,
              label: profile.label,
              active: profile.active,
            })
            const contextual = required(yield* catalog.model.forConnection(selected, snapshot))
            expect(contextual).toMatchObject({
              package: "@ycoding-ai/ai/providers/openai",
              settings: {
                baseURL: "http://127.0.0.1:45678/v1",
                privateInventory: profile.label,
                nested: { retained: profile.label, provider: "configured", model: "configured", precedence: "model" },
              },
              headers: { "x-account": profile.label, "x-provider": "configured", "x-precedence": "model" },
              body: {
                nested: { retained: profile.label, provider: "configured", model: "configured", precedence: "model" },
              },
            })
            expect(contextual.variants?.map((variant) => variant.id)).toEqual([
              CatalogModel.VariantID.make(profile.label === "Work" ? "high" : "low"),
            ])
            const variant = yield* SessionRunnerModel.withVariant(contextual, contextual.variants?.[0]?.id)
            expect(variant.body?.nested).toEqual({
              retained: profile.label,
              provider: "configured",
              model: "configured",
              variant: profile.label,
              precedence: "model",
            })
            expect(
              yield* catalog.model.get(account.providerID, CatalogModel.ID.make("inaccessible"), profile.label),
            ).toBeUndefined()
          }
          expect((yield* catalog.model.get(account.providerID, CatalogModel.ID.make("work-only"), "Work"))?.name).toBe(
            "Configured Work only",
          )
          expect(
            yield* catalog.model.get(account.providerID, CatalogModel.ID.make("work-only"), "Personal"),
          ).toBeUndefined()
        }
      }),
  )

  it.live("discovers custom models for every named account and keeps exact profile metadata isolated", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const server = Bun.serve({
          port: 0,
          fetch(request) {
            const auth = request.headers.get("authorization") ?? ""
            requests.push(auth)
            const work = auth === "Bearer fixture-work"
            return Response.json({
              object: "list",
              data: [
                {
                  id: work ? "work-only" : "personal-only",
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                },
                {
                  id: "shared",
                  limit: { context: work ? 160000 : 32000, output: 1000 },
                  variants: [{ id: work ? "high" : "low", settings: { reasoningEffort: work ? "high" : "low" } }],
                },
              ],
            })
          },
        })
        return { requests, server }
      }),
      ({ server, requests }) =>
        Effect.gen(function* () {
          const credentials = yield* Credential.Service
          const catalog = yield* Catalog.Service
          const providerID = Provider.ID.make("profile-discovery")
          yield* credentials.create({
            integrationID: Integration.ID.make(providerID),
            label: "Work",
            value: { type: "key", key: "fixture-work" },
          })
          yield* credentials.create({
            integrationID: Integration.ID.make(providerID),
            label: "Personal",
            value: { type: "key", key: "fixture-personal" },
          })
          yield* addPlugin(
            Config.Service.of({
              reload: () => Effect.void,
              entries: () =>
                Effect.succeed([
                  new Config.Document({
                    type: "document",
                    info: decode({
                      providers: {
                        [providerID]: {
                          package: "aisdk:@ai-sdk/openai-compatible",
                          settings: { baseURL: `http://127.0.0.1:${server.port}/v1` },
                          catalog: { source: "openai-models" },
                          models: { shared: { headers: { "x-fixture": "configured" } } },
                        },
                      },
                    }),
                  }),
                ]),
            }),
          )
          expect(requests.toSorted()).toEqual(["Bearer fixture-personal", "Bearer fixture-work"])
          expect(
            (yield* catalog.model.get(providerID, CatalogModel.ID.make("work-only"), "Work"))?.profiles?.map(
              (profile) => profile.name,
            ),
          ).toEqual(["Work"])
          expect(yield* catalog.model.get(providerID, CatalogModel.ID.make("work-only"), "Personal")).toBeUndefined()
          expect(yield* catalog.model.get(providerID, CatalogModel.ID.make("shared"), "Work")).toMatchObject({
            limit: { context: 160000 },
            variants: [{ id: "high" }],
            headers: { "x-fixture": "configured" },
          })
          expect(yield* catalog.model.get(providerID, CatalogModel.ID.make("shared"), "Personal")).toMatchObject({
            limit: { context: 32000 },
            variants: [{ id: "low" }],
          })
          expect(JSON.stringify(yield* catalog.model.available())).not.toContain("fixture-work")
          expect(JSON.stringify(yield* catalog.model.available())).not.toContain("fixture-personal")
        }),
      ({ server }) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.effect("registers credential profiles for configured Runpod endpoints", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      yield* addPlugin(
        Config.Service.of({
          reload: () => Effect.void,
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    "runpod-a": {
                      package: "@ycoding-ai/ai/providers/runpod",
                      settings: { worker: "ollama", baseURL: "https://api.runpod.ai/v2/a" },
                      models: { ollama: { capabilities: { tools: true } } },
                    },
                    "runpod-b": {
                      package: "@ycoding-ai/ai/providers/runpod",
                      settings: { worker: "vllm", baseURL: "https://api.runpod.ai/v2/b" },
                      models: { coder: { modelID: "org/coder", capabilities: { tools: true } } },
                    },
                  },
                }),
              }),
            ]),
        }),
      )
      for (const name of ["runpod-a", "runpod-b"]) {
        const id = Integration.ID.make(name)
        expect((yield* integrations.get(id))?.methods).toContainEqual({ type: "key", label: "API key" })
        yield* integrations.connection.key({ integrationID: id, key: "first-key", label: "Work" })
        yield* integrations.connection.key({ integrationID: id, key: "second-key", label: "Personal" })
        expect(
          (yield* integrations.get(id))?.connections
            .filter((connection) => connection.type === "credential")
            .map((connection) => ({ label: connection.label, active: connection.active })),
        ).toEqual(
          expect.arrayContaining([
            { label: "Work", active: false },
            { label: "Personal", active: true },
          ]),
        )
      }
      for (const [provider, modelID, route, endpoint] of [
        ["runpod-a", "ollama", "runpod-ollama", "https://api.runpod.ai/v2/a/runsync"],
        ["runpod-b", "coder", "runpod-vllm", "https://api.runpod.ai/v2/b/runsync"],
      ] as const) {
        const entry = required(yield* catalog.model.get(Provider.ID.make(provider), CatalogModel.ID.make(modelID)))
        expect(entry.capabilities.tools).toBe(true)
        const connection = required(yield* integrations.connection.active(Integration.ID.make(provider)))
        const selected = yield* SessionRunnerModel.fromCatalogModel(
          entry,
          yield* integrations.connection.resolve(connection),
        )
        expect(selected.route.id).toBe(route)
        const prepared = yield* LLMClient.prepare(LLM.request({ model: selected, prompt: "Hello" }))
        expect(`${selected.route.endpoint.baseURL}/runsync`).toBe(endpoint)
        if (route === "runpod-vllm") expect(prepared.body).toMatchObject({ input: { body: { model: "org/coder" } } })
      }
    }),
  )
  it.effect("registers a key method for a configured compatible provider without env", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const id = Integration.ID.make("private-compatible")
      yield* addPlugin(
        Config.Service.of({
          reload: () => Effect.void,
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    [id]: {
                      name: "Private endpoint",
                      package: "aisdk:@ai-sdk/openai-compatible",
                      settings: { baseURL: "https://example.test/v1" },
                    },
                    "compatible-env": {
                      package: "aisdk:@ai-sdk/openai-compatible",
                      env: ["COMPATIBLE_KEY"],
                      settings: { baseURL: "https://example.test/v1" },
                    },
                  },
                }),
              }),
            ]),
        }),
      )

      expect((yield* integrations.get(id))?.methods).toContainEqual({ type: "key", label: "API key" })
      expect((yield* integrations.get(Integration.ID.make("compatible-env")))?.methods).toContainEqual({
        type: "key",
        label: "API key",
      })
      expect((yield* integrations.get(Integration.ID.make("compatible-env")))?.methods).toContainEqual({
        type: "env",
        names: ["COMPATIBLE_KEY"],
      })
      yield* integrations.connection.key({ integrationID: id, key: "private-key", label: "Work" })
      expect((yield* integrations.get(id))?.connections).toMatchObject([
        { type: "credential", label: "Work", active: true },
      ])
      expect(JSON.stringify(yield* integrations.get(id))).not.toContain("private-key")
    }),
  )

  it.live(
    "uses the selected stored profile for model discovery and never follows authenticated redirects",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const requests: string[] = []
          const destination = Bun.serve({
            port: 0,
            fetch(request) {
              requests.push(`destination:${request.headers.get("authorization") ?? ""}`)
              return Response.json({ object: "list", data: [{ id: "redirected-model" }] })
            },
          })
          const source = Bun.serve({
            port: 0,
            fetch(request) {
              const auth = request.headers.get("authorization") ?? ""
              requests.push(`source:${auth}`)
              if (auth === "Bearer redirect-key")
                return Response.redirect(`http://127.0.0.1:${destination.port}/models`)
              return Response.json({
                object: "list",
                data: [
                  {
                    id:
                      auth === "Bearer second-key"
                        ? "second-model"
                        : auth === "Bearer rotated-key"
                          ? "rotated-model"
                          : "first-model",
                  },
                ],
              })
            },
          })
          return { requests, source, destination }
        }),
        ({ requests, source }) =>
          Effect.gen(function* () {
            const integrations = yield* Integration.Service
            const credentials = yield* Credential.Service
            const catalog = yield* Catalog.Service
            const id = Integration.ID.make("credential-catalog")
            const blockedID = Integration.ID.make("insecure-catalog")
            const first = yield* credentials.create({
              integrationID: id,
              label: "First",
              value: Credential.Key.make({ type: "key", key: "first-key" }),
            })
            yield* credentials.create({
              integrationID: blockedID,
              value: Credential.Key.make({ type: "key", key: "blocked-key" }),
            })
            yield* addPlugin(
              Config.Service.of({
                reload: () => Effect.void,
                entries: () =>
                  Effect.succeed([
                    new Config.Document({
                      type: "document",
                      info: decode({
                        providers: {
                          [id]: {
                            package: "aisdk:@ai-sdk/openai-compatible",
                            settings: { baseURL: `http://127.0.0.1:${source.port}/v1` },
                            catalog: { source: "openai-models" },
                          },
                          [blockedID]: {
                            package: "aisdk:@ai-sdk/openai-compatible",
                            settings: { baseURL: `http://0.0.0.0:${source.port}/v1` },
                            catalog: { source: "openai-models" },
                          },
                        },
                      }),
                    }),
                  ]),
              }),
            )
            expect(requests).toEqual(["source:Bearer first-key"])
            expect(yield* catalog.model.get(Provider.ID.make(id), CatalogModel.ID.make("first-model"))).toBeDefined()
            expect(
              yield* catalog.model.get(Provider.ID.make(blockedID), CatalogModel.ID.make("first-model")),
            ).toBeUndefined()
            expect(JSON.stringify(yield* catalog.provider.get(Provider.ID.make(id)))).not.toContain("first-key")
            expect(
              JSON.stringify(yield* catalog.model.get(Provider.ID.make(id), CatalogModel.ID.make("first-model"))),
            ).not.toContain("first-key")

            yield* integrations.connection.key({ integrationID: id, key: "second-key", label: "Second" })
            yield* waitFor(() =>
              catalog.model.get(Provider.ID.make(id), CatalogModel.ID.make("second-model")).pipe(Effect.map(Boolean)),
            )
            expect(requests).toContain("source:Bearer second-key")
            expect(yield* catalog.model.get(Provider.ID.make(id), CatalogModel.ID.make("second-model"))).toBeDefined()
            yield* integrations.connection.activate(first.id)
            yield* waitFor(() =>
              Effect.sync(() => requests.filter((request) => request === "source:Bearer first-key").length === 2),
            )
            yield* integrations.connection.key({ integrationID: id, key: "rotated-key", label: "First" })
            yield* waitFor(() =>
              catalog.model.get(Provider.ID.make(id), CatalogModel.ID.make("rotated-model")).pipe(Effect.map(Boolean)),
            )
            expect(requests).toContain("source:Bearer rotated-key")
            yield* integrations.connection.key({ integrationID: id, key: "redirect-key", label: "Redirect" })
            yield* waitFor(() => Effect.sync(() => requests.includes("source:Bearer redirect-key")))
            expect(requests.some((request) => request.startsWith("destination:"))).toBe(false)
            expect(
              yield* catalog.model.get(Provider.ID.make(id), CatalogModel.ID.make("redirected-model")),
            ).toBeUndefined()
            expect(JSON.stringify(yield* integrations.get(id))).not.toMatch(
              /first-key|second-key|rotated-key|redirect-key/,
            )
          }),
        ({ source, destination }) => Effect.promise(() => Promise.all([source.stop(true), destination.stop(true)])),
      ),
    10000,
  )

  it.effect("keeps config-key and header discovery on remote HTTP with ordinary redirects", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const server = Bun.serve({
          port: 0,
          fetch(request) {
            const url = new URL(request.url)
            requests.push(`${url.pathname}:${request.headers.get("authorization") ?? ""}`)
            if (url.pathname.endsWith("/models")) return Response.redirect(new URL("/catalog", url).toString())
            return Response.json({
              object: "list",
              data: [
                { id: request.headers.get("authorization") === "Bearer configured-key" ? "key-model" : "header-model" },
              ],
            })
          },
        })
        return { server, requests }
      }),
      ({ server, requests }) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          const baseURL = `http://0.0.0.0:${server.port}/v1`
          yield* addPlugin(
            Config.Service.of({
              reload: () => Effect.void,
              entries: () =>
                Effect.succeed([
                  new Config.Document({
                    type: "document",
                    info: decode({
                      providers: {
                        "config-key": {
                          settings: { baseURL, apiKey: "configured-key" },
                          catalog: { source: "openai-models" },
                        },
                        "config-header": {
                          settings: { baseURL },
                          headers: { Authorization: "Bearer header-key" },
                          catalog: { source: "openai-models" },
                        },
                      },
                    }),
                  }),
                ]),
            }),
          )
          expect(requests).toContain("/v1/models:Bearer configured-key")
          expect(requests).toContain("/catalog:Bearer configured-key")
          expect(requests).toContain("/v1/models:Bearer header-key")
          expect(requests).toContain("/catalog:Bearer header-key")
          expect(
            yield* catalog.model.get(Provider.ID.make("config-key"), CatalogModel.ID.make("key-model")),
          ).toBeDefined()
          expect(
            yield* catalog.model.get(Provider.ID.make("config-header"), CatalogModel.ID.make("header-model")),
          ).toBeDefined()
        }),
      ({ server }) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.effect("discovers authenticated OpenAI-compatible models and overlays standard catalog metadata", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        let authorization = ""
        const server = Bun.serve({
          port: 0,
          fetch(request) {
            authorization = request.headers.get("authorization") ?? ""
            if (new URL(request.url).pathname !== "/v1/models") return new Response("not found", { status: 404 })
            return Response.json({
              object: "list",
              data: [
                {
                  id: "remote-model",
                  object: "model",
                  owned_by: "remote",
                  name: "Remote Model",
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  limit: { context: 131_072, input: 98_304, output: 32_768 },
                  variants: [{ id: "high", body: { reasoning: { mode: "high" } } }],
                },
              ],
            })
          },
        })
        return { server, authorization: () => authorization }
      }),
      ({ server, authorization }) =>
        Effect.gen(function* () {
          const catalog = yield* Catalog.Service
          yield* catalog.transform((draft) =>
            draft.model.update(Provider.ID.openrouter, CatalogModel.ID.make("remote-model"), (model) => {
              model.name = "Remote Model"
              model.limit = { context: 200_000, output: 20_000 }
              model.capabilities = { tools: false, input: ["text", "image"], output: ["text"] }
            }),
          )
          const config = Config.Service.of({
            reload: () => Effect.void,
            entries: () =>
              Effect.succeed([
                new Config.Document({
                  type: "document",
                  info: decode({
                    providers: {
                      discovered: {
                        package: "aisdk:@ai-sdk/openai-compatible",
                        settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "secret" },
                        catalog: { source: "openai-models" },
                      },
                    },
                  }),
                }),
              ]),
          })

          yield* addPlugin(config)

          expect(authorization()).toBe("Bearer secret")
          const model = required(
            yield* catalog.model.get(Provider.ID.make("discovered"), CatalogModel.ID.make("remote-model")),
          )
          expect(model).toMatchObject({
            name: "Remote Model",
            limit: { context: 131_072, input: 98_304, output: 32_768 },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [{ id: "high", body: { reasoning: { mode: "high" } } }],
          })
        }),
      ({ server }) => Effect.sync(() => server.stop(true)),
    ),
  )

  it.effect("keeps configured model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.opencode
      const modelID = CatalogModel.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        reload: () => Effect.void,
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  [providerID]: {
                    package: "aisdk:@ai-sdk/openai",
                    settings: { baseURL: "https://provider.test/v1" },
                    models: {
                      "alpha-gpt-next": {
                        variants: [
                          {
                            id: "high",
                            body: {
                              reasoningEffort: "high",
                              reasoningSummary: "auto",
                              include: ["reasoning.encrypted_content"],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants).toMatchObject([
        {
          id: "high",
          body: {
            reasoningEffort: "high",
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        },
      ])
    }),
  )

  it.effect("keeps layered model variant bodies unchanged", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.opencode
      const modelID = CatalogModel.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        reload: () => Effect.void,
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  [providerID]: {
                    package: "aisdk:@ai-sdk/openai",
                    settings: { baseURL: "https://provider.test/v1" },
                  },
                },
              }),
            }),
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  [providerID]: {
                    models: {
                      "alpha-gpt-next": {
                        variants: [{ id: "high", body: { reasoningEffort: "high" } }],
                      },
                    },
                  },
                },
              }),
            }),
          ]),
      })

      yield* addPlugin(config)

      const model = required(yield* catalog.model.get(providerID, modelID))
      expect(model.variants?.[0]).toMatchObject({
        id: "high",
        body: { reasoningEffort: "high" },
      })
    }),
  )

  it.effect("loads configured providers and applies later model overrides", () =>
    withEnv({ CUSTOM_API_KEY: "secret" }, () =>
      Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const integrations = yield* Integration.Service
        const providerID = Provider.ID.make("custom")
        const modelID = CatalogModel.ID.make("chat")
        const config = Config.Service.of({
          reload: () => Effect.void,
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: decode({
                  model: "custom/first",
                  providers: {
                    custom: {
                      name: "Configured",
                      env: ["CUSTOM_API_KEY"],
                      package: "native",
                      headers: { first: "first", shared: "first" },
                      models: {
                        chat: {
                          name: "First",
                          capabilities: { tools: true, input: ["text"], output: ["text"] },
                          disabled: true,
                          limit: { context: 100, output: 50 },
                          cost: { input: 1, output: 2 },
                          settings: { retained: true },
                          headers: { first: "first", shared: "first" },
                          variants: [
                            {
                              id: "fast",
                              headers: { first: "first", shared: "first" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  model: { providerID: "custom", model: "default", variant: "fast", profile: "Work" },
                  providers: {
                    custom: {
                      package: "aisdk:custom-sdk",
                      settings: { baseURL: "https://example.test" },
                      headers: { last: "last", shared: "last" },
                      models: {
                        default: {
                          name: "Default",
                          variants: [{ id: "fast" }],
                        },
                        chat: {
                          modelID: "api-chat",
                          name: "Last",
                          capabilities: { input: ["text", "image"] },
                          limit: { output: 75 },
                          headers: { last: "last", shared: "last" },
                          variants: [
                            {
                              id: "fast",
                              headers: { last: "last", shared: "last" },
                            },
                            {
                              id: "slow",
                              headers: { slow: "slow" },
                            },
                          ],
                        },
                      },
                    },
                  },
                }),
              }),
              new Config.Document({
                type: "document",
                info: decode({
                  providers: {
                    custom: { name: "Renamed" },
                  },
                }),
              }),
            ]),
        })

        yield* addPlugin(config)

        const provider = required(yield* catalog.provider.get(providerID))
        const model = required(yield* catalog.model.get(providerID, modelID))
        expect(yield* catalog.model.default()).toBeUndefined()
        yield* (yield* Credential.Service).create({
          integrationID: Integration.ID.make(providerID),
          label: "Work",
          value: { type: "key", key: "fixture-default" },
        })
        expect((yield* catalog.model.default())?.id).toBe(CatalogModel.ID.make("default"))
        expect(yield* catalog.model.defaultSelection()).toMatchObject({
          providerID: "custom",
          id: "default",
          variant: "fast",
          profile: "Work",
        })
        expect(provider.name).toBe("Renamed")
        expect((yield* integrations.get(Integration.ID.make("custom")))?.methods).toContainEqual({
          type: "env",
          names: ["CUSTOM_API_KEY"],
        })
        expect((yield* integrations.get(Integration.ID.make("custom")))?.name).toBe("Renamed")
        expect(provider.disabled).toBeUndefined()
        expect(provider.package).toBe("aisdk:custom-sdk")
        expect(provider.settings).toEqual({ baseURL: "https://example.test" })
        expect(provider.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.id).toBe(modelID)
        expect(model.modelID).toBe(CatalogModel.ID.make("api-chat"))
        expect(model.name).toBe("Last")
        expect(model.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
        expect(model.enabled).toBe(false)
        expect(model.limit).toEqual({ context: 100, output: 75 })
        expect(model.cost).toEqual([
          {
            input: Money.USDPerMillionTokens.make(1),
            output: Money.USDPerMillionTokens.make(2),
            cache: {
              read: Money.USDPerMillionTokens.zero,
              write: Money.USDPerMillionTokens.zero,
            },
            tier: undefined,
          },
        ])
        expect(model.settings).toEqual({ baseURL: "https://example.test", retained: true })
        expect(model.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants?.map((variant) => variant.id)).toEqual([
          CatalogModel.VariantID.make("fast"),
          CatalogModel.VariantID.make("slow"),
        ])
        expect(model.variants?.[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants?.[1]?.headers).toEqual({ slow: "slow" })
      }),
    ),
  )
})
