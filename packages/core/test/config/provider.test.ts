import { describe, expect } from "bun:test"
import { Money } from "@ycoding-ai/schema/money"
import { Effect, Schema } from "effect"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Config } from "@ycoding-ai/core/config"
import { ConfigProviderPlugin } from "@ycoding-ai/core/config/plugin/provider"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { ModelV2 } from "@ycoding-ai/core/model"
import { PluginV2 } from "@ycoding-ai/core/plugin"
import { PluginHost } from "@ycoding-ai/core/plugin/host"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { LLM, LLMClient } from "@ycoding-ai/ai"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* (config: Config.Interface) {
  const plugin = yield* PluginV2.Service
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
  it.effect("registers credential profiles for configured Runpod endpoints", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      yield* addPlugin(Config.Service.of({ entries: () => Effect.succeed([new Config.Document({
        type: "document",
        info: decode({ providers: {
          "runpod-a": { package: "@ycoding-ai/ai/providers/runpod", settings: { worker: "ollama", baseURL: "https://api.runpod.ai/v2/a" }, models: { ollama: { capabilities: { tools: true } } } },
          "runpod-b": { package: "@ycoding-ai/ai/providers/runpod", settings: { worker: "vllm", baseURL: "https://api.runpod.ai/v2/b" }, models: { coder: { modelID: "org/coder", capabilities: { tools: true } } } },
        } }),
      })]) }))
      for (const name of ["runpod-a", "runpod-b"]) {
        const id = Integration.ID.make(name)
        expect((yield* integrations.get(id))?.methods).toContainEqual({ type: "key", label: "API key" })
        yield* integrations.connection.key({ integrationID: id, key: "first-key", label: "Work" })
        yield* integrations.connection.key({ integrationID: id, key: "second-key", label: "Personal" })
        expect((yield* integrations.get(id))?.connections.filter((connection) => connection.type === "credential").map((connection) => ({ label: connection.label, active: connection.active })))
          .toEqual(expect.arrayContaining([{ label: "Work", active: false }, { label: "Personal", active: true }]))
      }
      for (const [provider, modelID, route, endpoint] of [
        ["runpod-a", "ollama", "runpod-ollama", "https://api.runpod.ai/v2/a/runsync"],
        ["runpod-b", "coder", "runpod-vllm", "https://api.runpod.ai/v2/b/runsync"],
      ] as const) {
        const entry = required(yield* catalog.model.get(ProviderV2.ID.make(provider), ModelV2.ID.make(modelID)))
        expect(entry.capabilities.tools).toBe(true)
        const connection = required(yield* integrations.connection.active(Integration.ID.make(provider)))
        const selected = yield* SessionRunnerModel.fromCatalogModel(entry, yield* integrations.connection.resolve(connection))
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
      yield* addPlugin(Config.Service.of({
        entries: () => Effect.succeed([new Config.Document({
          type: "document",
          info: decode({ providers: {
            [id]: { name: "Private endpoint", package: "aisdk:@ai-sdk/openai-compatible", settings: { baseURL: "https://example.test/v1" } },
            "compatible-env": { package: "aisdk:@ai-sdk/openai-compatible", env: ["COMPATIBLE_KEY"], settings: { baseURL: "https://example.test/v1" } },
          } }),
        })]),
      }))

      expect((yield* integrations.get(id))?.methods).toContainEqual({ type: "key", label: "API key" })
      expect((yield* integrations.get(Integration.ID.make("compatible-env")))?.methods).toContainEqual({ type: "key", label: "API key" })
      expect((yield* integrations.get(Integration.ID.make("compatible-env")))?.methods).toContainEqual({ type: "env", names: ["COMPATIBLE_KEY"] })
      yield* integrations.connection.key({ integrationID: id, key: "private-key", label: "Work" })
      expect((yield* integrations.get(id))?.connections).toMatchObject([
        { type: "credential", label: "Work", active: true },
      ])
      expect(JSON.stringify(yield* integrations.get(id))).not.toContain("private-key")
    }),
  )

  it.live("uses the selected stored profile for model discovery and never follows authenticated redirects", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const destination = Bun.serve({ port: 0, fetch(request) {
          requests.push(`destination:${request.headers.get("authorization") ?? ""}`)
          return Response.json({ object: "list", data: [{ id: "redirected-model" }] })
        } })
        const source = Bun.serve({ port: 0, fetch(request) {
          const auth = request.headers.get("authorization") ?? ""
          requests.push(`source:${auth}`)
          if (auth === "Bearer redirect-key") return Response.redirect(`http://127.0.0.1:${destination.port}/models`)
          return Response.json({ object: "list", data: [{ id: auth === "Bearer second-key" ? "second-model" : auth === "Bearer rotated-key" ? "rotated-model" : "first-model" }] })
        } })
        return { requests, source, destination }
      }),
      ({ requests, source }) => Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        const catalog = yield* Catalog.Service
        const id = Integration.ID.make("credential-catalog")
        const blockedID = Integration.ID.make("insecure-catalog")
        const first = yield* credentials.create({
          integrationID: id, label: "First", value: Credential.Key.make({ type: "key", key: "first-key" }),
        })
        yield* credentials.create({
          integrationID: blockedID, value: Credential.Key.make({ type: "key", key: "blocked-key" }),
        })
        yield* addPlugin(Config.Service.of({ entries: () => Effect.succeed([new Config.Document({
          type: "document",
          info: decode({ providers: {
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
          } }),
        })]) }))
        expect(requests).toEqual(["source:Bearer first-key"])
        expect(yield* catalog.model.get(ProviderV2.ID.make(id), ModelV2.ID.make("first-model"))).toBeDefined()
        expect(yield* catalog.model.get(ProviderV2.ID.make(blockedID), ModelV2.ID.make("first-model"))).toBeUndefined()
        expect(JSON.stringify(yield* catalog.provider.get(ProviderV2.ID.make(id)))).not.toContain("first-key")
        expect(JSON.stringify(yield* catalog.model.get(ProviderV2.ID.make(id), ModelV2.ID.make("first-model")))).not.toContain("first-key")

        yield* integrations.connection.key({ integrationID: id, key: "second-key", label: "Second" })
        yield* waitFor(() => catalog.model.get(ProviderV2.ID.make(id), ModelV2.ID.make("second-model")).pipe(Effect.map(Boolean)))
        expect(requests).toContain("source:Bearer second-key")
        expect(yield* catalog.model.get(ProviderV2.ID.make(id), ModelV2.ID.make("second-model"))).toBeDefined()
        yield* integrations.connection.activate(first.id)
        yield* waitFor(() => Effect.sync(() => requests.filter((request) => request === "source:Bearer first-key").length === 2))
        yield* integrations.connection.key({ integrationID: id, key: "rotated-key", label: "First" })
        yield* waitFor(() => catalog.model.get(ProviderV2.ID.make(id), ModelV2.ID.make("rotated-model")).pipe(Effect.map(Boolean)))
        expect(requests).toContain("source:Bearer rotated-key")
        yield* integrations.connection.key({ integrationID: id, key: "redirect-key", label: "Redirect" })
        yield* waitFor(() => Effect.sync(() => requests.includes("source:Bearer redirect-key")))
        expect(requests.some((request) => request.startsWith("destination:"))).toBe(false)
        expect(yield* catalog.model.get(ProviderV2.ID.make(id), ModelV2.ID.make("redirected-model"))).toBeUndefined()
        expect(JSON.stringify(yield* integrations.get(id))).not.toMatch(/first-key|second-key|rotated-key|redirect-key/)
      }),
      ({ source, destination }) => Effect.promise(() => Promise.all([source.stop(true), destination.stop(true)])),
    ), 10000,
  )

  it.effect("keeps config-key and header discovery on remote HTTP with ordinary redirects", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requests: string[] = []
        const server = Bun.serve({ port: 0, fetch(request) {
          const url = new URL(request.url)
          requests.push(`${url.pathname}:${request.headers.get("authorization") ?? ""}`)
          if (url.pathname.endsWith("/models")) return Response.redirect(new URL("/catalog", url).toString())
          return Response.json({ object: "list", data: [{ id: request.headers.get("authorization") === "Bearer configured-key" ? "key-model" : "header-model" }] })
        } })
        return { server, requests }
      }),
      ({ server, requests }) => Effect.gen(function* () {
        const catalog = yield* Catalog.Service
        const baseURL = `http://0.0.0.0:${server.port}/v1`
        yield* addPlugin(Config.Service.of({ entries: () => Effect.succeed([new Config.Document({
          type: "document",
          info: decode({ providers: {
            "config-key": { settings: { baseURL, apiKey: "configured-key" }, catalog: { source: "openai-models" } },
            "config-header": { settings: { baseURL }, headers: { Authorization: "Bearer header-key" }, catalog: { source: "openai-models" } },
          } }),
        })]) }))
        expect(requests).toContain("/v1/models:Bearer configured-key")
        expect(requests).toContain("/catalog:Bearer configured-key")
        expect(requests).toContain("/v1/models:Bearer header-key")
        expect(requests).toContain("/catalog:Bearer header-key")
        expect(yield* catalog.model.get(ProviderV2.ID.make("config-key"), ModelV2.ID.make("key-model"))).toBeDefined()
        expect(yield* catalog.model.get(ProviderV2.ID.make("config-header"), ModelV2.ID.make("header-model"))).toBeDefined()
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
            draft.model.update(ProviderV2.ID.openrouter, ModelV2.ID.make("remote-model"), (model) => {
              model.name = "Remote Model"
              model.limit = { context: 200_000, output: 20_000 }
              model.capabilities = { tools: false, input: ["text", "image"], output: ["text"] }
            }),
          )
          const config = Config.Service.of({
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
            yield* catalog.model.get(ProviderV2.ID.make("discovered"), ModelV2.ID.make("remote-model")),
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
      const providerID = ProviderV2.ID.opencode
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: { // YCODING_EXTERNAL_OPENCODE: external provider fixture
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
      const providerID = ProviderV2.ID.opencode
      const modelID = ModelV2.ID.make("alpha-gpt-next")
      const config = Config.Service.of({
        entries: () =>
          Effect.succeed([
            new Config.Document({
              type: "document",
              info: decode({
                providers: {
                  opencode: { // YCODING_EXTERNAL_OPENCODE: external provider fixture
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
                  opencode: { // YCODING_EXTERNAL_OPENCODE: external provider fixture
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
        const providerID = ProviderV2.ID.make("custom")
        const modelID = ModelV2.ID.make("chat")
        const config = Config.Service.of({
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
                  model: "custom/default",
                  providers: {
                    custom: {
                      package: "aisdk:custom-sdk",
                      settings: { baseURL: "https://example.test" },
                      headers: { last: "last", shared: "last" },
                      models: {
                        default: {
                          name: "Default",
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
        expect((yield* catalog.model.default())?.id).toBe(ModelV2.ID.make("default"))
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
        expect(model.modelID).toBe(ModelV2.ID.make("api-chat"))
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
          ModelV2.VariantID.make("fast"),
          ModelV2.VariantID.make("slow"),
        ])
        expect(model.variants?.[0]?.headers).toEqual({ first: "first", shared: "last", last: "last" })
        expect(model.variants?.[1]?.headers).toEqual({ slow: "slow" })
      }),
    ),
  )
})
