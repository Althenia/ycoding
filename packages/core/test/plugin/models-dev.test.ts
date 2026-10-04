import path from "path"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { describe, expect } from "bun:test"
import { LLM, Model } from "@ycoding-ai/ai"
import { LLMClient, RequestExecutor } from "@ycoding-ai/ai/route"
import { Money } from "@ycoding-ai/schema/money"
import { Effect, Layer } from "effect"
import { HttpClientResponse } from "effect/unstable/http"
import { Catalog } from "@ycoding-ai/core/catalog"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Location } from "@ycoding-ai/core/location"
import { CatalogModel } from "@ycoding-ai/core/model"
import { ModelsDev } from "@ycoding-ai/core/models-dev"
import { ModelsDevPlugin } from "@ycoding-ai/core/plugin/models-dev"
import { OpenRouterPlugin } from "@ycoding-ai/core/plugin/provider/openrouter"
import { Provider } from "@ycoding-ai/core/provider"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionRunnerModel } from "@ycoding-ai/core/session/runner/model"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Integration.node, EventRuntime.node]), [
  [Location.node, locationLayer],
])
const it = testEffect(layer)
const models = (file: string) =>
  AppNodeBuilder.build(ModelsDev.node, [[ModelsDev.node, ModelsDev.configured({ file, fetch: false })]])

const captureRequestBody = (model: Model) => Effect.gen(function* () {
  const requests: unknown[] = []
  yield* LLMClient.generate(LLM.request({ model, prompt: "Hello" })).pipe(
    Effect.provide(LLMClient.configured()),
    Effect.provideService(RequestExecutor.Service, {
      execute: (request) => Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") throw new Error("Expected a JSON byte body")
        requests.push(JSON.parse(new TextDecoder().decode(request.body.body)))
        return HttpClientResponse.fromWeb(request, new Response("Fixture rejected request", { status: 400 }))
      }),
    }),
    Effect.flip,
  )
  expect(requests).toHaveLength(1)
  return requests[0]
})

describe("ModelsDevPlugin", () => {
  for (const effort of ["low", "medium", "xhigh"])
    it.effect(`preserves the source OpenRouter DeepSeek ${effort} effort through selection and encoded requests`, () =>
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "ycoding-models-dev-"))).pipe(
        Effect.flatMap((directory) => Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(directory, "models.json"), JSON.stringify({
            openrouter: {
              id: "openrouter", name: "OpenRouter", env: [], npm: "@openrouter/ai-sdk-provider",
              models: {
                "deepseek/effort-fixture": {
                  id: "deepseek/effort-fixture", name: "DeepSeek Effort Fixture", release_date: "2026-01-01",
                  attachment: false, reasoning: true, tool_call: true,
                  reasoning_options: [{ type: "effort", values: ["low", "medium", "xhigh"] }],
                  limit: { context: 1000, output: 100 },
                },
              },
            },
          })))
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          yield* ModelsDevPlugin.effect(host({ catalog: catalogHost(catalog), integration: integrationHost(integrations) }))
          yield* OpenRouterPlugin.effect(host({ catalog: catalogHost(catalog), aisdk: { hook: () => Effect.succeed({ dispose: Effect.void }) } }))
          const model = yield* catalog.model.get(Provider.ID.openrouter, CatalogModel.ID.make("deepseek/effort-fixture"))
          if (!model) throw new Error("Fixture catalog model missing")
          expect(model.variants.map((variant) => variant.id)).toEqual(["low", "medium", "xhigh"].map((id) => CatalogModel.VariantID.make(id)))
          const selected = yield* SessionRunnerModel.withVariant(model, CatalogModel.VariantID.make(effort))
          expect(selected.settings?.reasoning).toEqual({ effort })
          const resolved = yield* SessionRunnerModel.fromCatalogModel(selected, Credential.Key.make({ type: "key", key: "fixture-key" }))
          expect(yield* captureRequestBody(resolved)).toMatchObject({ model: "deepseek/effort-fixture", reasoning: { effort } })
        }).pipe(
          Effect.provide(models(path.join(directory, "models.json"))),
          Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
        )),
      ),
    )

  for (const scenario of [
    { provider: "alibaba", npm: "@ai-sdk/alibaba" },
    { provider: "cohere", npm: "@ai-sdk/cohere" },
  ])
    it.effect(`uses the pinned ${scenario.provider} toggle identities without accepting removed aliases`, () =>
      Effect.promise(() => mkdtemp(path.join(tmpdir(), "ycoding-models-dev-"))).pipe(
        Effect.flatMap((directory) => Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(path.join(directory, "models.json"), JSON.stringify({
            [scenario.provider]: {
              id: scenario.provider, name: scenario.provider, env: [], npm: scenario.npm,
              models: {
                "toggle-fixture": {
                  id: "toggle-fixture", name: "Toggle Fixture", release_date: "2026-01-01",
                  attachment: false, reasoning: true, tool_call: true,
                  reasoning_options: [{ type: "toggle" }], limit: { context: 1000, output: 100 },
                },
              },
            },
          })))
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          yield* ModelsDevPlugin.effect(host({ catalog: catalogHost(catalog), integration: integrationHost(integrations) }))
          const model = yield* catalog.model.get(Provider.ID.make(scenario.provider), CatalogModel.ID.make("toggle-fixture"))
          if (!model) throw new Error("Fixture catalog model missing")
          expect(model.variants.map((variant) => variant.id)).toEqual(["none", "high"].map((id) => CatalogModel.VariantID.make(id)))
          const selected = yield* SessionRunnerModel.withVariant(model, CatalogModel.VariantID.make("high"))
          if (scenario.provider === "alibaba") expect(selected.settings).toEqual({ enableThinking: true })
          if (scenario.provider === "cohere") expect(selected.settings).toEqual({ thinking: { type: "enabled" } })
          for (const removed of ["thinking", "default", "base"])
            expect(yield* SessionRunnerModel.withVariant(model, CatalogModel.VariantID.make(removed)).pipe(Effect.flip)).toMatchObject({
              _tag: "SessionRunnerModel.VariantUnavailableError", variant: removed,
            })
        }).pipe(
          Effect.provide(models(path.join(directory, "models.json"))),
          Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
        )),
      ),
    )

  it.effect("requests encrypted reasoning only for reasoning OpenAI base models", () =>
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "ycoding-models-dev-"))).pipe(
      Effect.flatMap((directory) => Effect.gen(function* () {
      const file = path.join(directory, "models.json")
      yield* Effect.promise(() => Bun.write(file, JSON.stringify({
        openai: {
          id: "openai",
          name: "OpenAI",
          env: [],
          npm: "@ai-sdk/openai",
          api: "https://api.openai.com/v1",
          models: {
            reasoning: {
              id: "reasoning",
              name: "Reasoning",
              release_date: "2026-01-01",
              attachment: false,
              reasoning: true,
              tool_call: true,
              limit: { context: 1000, output: 100 },
            },
            plain: {
              id: "plain",
              name: "Plain",
              release_date: "2026-01-01",
              attachment: false,
              reasoning: false,
              tool_call: true,
              limit: { context: 1000, output: 100 },
            },
          },
        },
        xai: {
          id: "xai",
          name: "xAI",
          env: [],
          npm: "@ai-sdk/xai",
          models: {
            reasoning: {
              id: "reasoning",
              name: "Reasoning",
              release_date: "2026-01-01",
              attachment: false,
              reasoning: true,
              tool_call: true,
              limit: { context: 1000, output: 100 },
            },
          },
        },
      })))
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      )

      expect((yield* catalog.model.get(Provider.ID.openai, CatalogModel.ID.make("reasoning")))?.settings).toEqual({
        baseURL: "https://api.openai.com/v1",
        include: ["reasoning.encrypted_content"],
      })
      expect((yield* catalog.model.get(Provider.ID.openai, CatalogModel.ID.make("plain")))?.settings).toEqual({
        baseURL: "https://api.openai.com/v1",
      })
      expect((yield* catalog.model.get(Provider.ID.make("xai"), CatalogModel.ID.make("reasoning")))?.settings).toBeUndefined()
      }).pipe(
        Effect.provide(models(path.join(directory, "models.json"))),
        Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
      )),
    ),
  )

  it.effect("maps DeepSeek variants to the thinking toggle and requested effort", () =>
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "ycoding-models-dev-"))).pipe(
      Effect.flatMap((directory) =>
        Effect.gen(function* () {
          const file = path.join(directory, "models.json")
          yield* Effect.promise(() =>
            Bun.write(
              file,
              JSON.stringify({
                deepseek: {
                  id: "deepseek",
                  name: "DeepSeek",
                  env: [],
                  npm: "@ai-sdk/openai-compatible",
                  api: "https://api.deepseek.com",
                  models: {
                    "deepseek-v4-pro": {
                      id: "deepseek-v4-pro",
                      name: "DeepSeek V4 Pro",
                      release_date: "2026-01-01",
                      attachment: false,
                      reasoning: true,
                      reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
                      tool_call: true,
                      limit: { context: 1000, output: 100 },
                    },
                  },
                },
              }),
            ),
          )
          const catalog = yield* Catalog.Service
          const integrations = yield* Integration.Service
          yield* ModelsDevPlugin.effect(
            host({
              catalog: catalogHost(catalog),
              integration: integrationHost(integrations),
            }),
          )

          const model = yield* catalog.model.get(Provider.ID.make("deepseek"), CatalogModel.ID.make("deepseek-v4-pro"))
          expect(model?.variants).toEqual([
            { id: CatalogModel.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
            { id: CatalogModel.VariantID.make("low"), settings: { reasoningEffort: "low", thinking: { type: "enabled" } } },
            { id: CatalogModel.VariantID.make("high"), settings: { reasoningEffort: "high", thinking: { type: "enabled" } } },
            { id: CatalogModel.VariantID.make("max"), settings: { reasoningEffort: "max", thinking: { type: "enabled" } } },
          ])
        }).pipe(
          Effect.provide(models(path.join(directory, "models.json"))),
          Effect.ensuring(Effect.promise(() => rm(directory, { recursive: true, force: true }))),
        ),
      ),
    ),
  )

  it.effect("projects normalized models.dev snapshots into the catalog", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const providerID = Provider.ID.make("acme")
      const modelID = CatalogModel.ID.make("gpt-5.4")
      const models = ModelsDev.Service.of({
        get: () =>
          Effect.succeed([
            {
              info: {
                id: providerID,
                name: "Acme",
                package: Provider.aisdk("@ai-sdk/openai-compatible"),
                settings: { baseURL: "https://api.acme.test/v1" },
              },
              environment: [],
              models: [
                {
                  id: modelID,
                  modelID,
                  providerID,
                  name: "GPT-5.4",
                  family: CatalogModel.Family.make("gpt"),
                  capabilities: { tools: true, input: [], output: [] },
                  variants: [],
                  time: { released: Date.parse("2026-01-01") },
                  cost: [
                    {
                      input: Money.USDPerMillionTokens.make(2.5),
                      output: Money.USDPerMillionTokens.make(15),
                      cache: {
                        read: Money.USDPerMillionTokens.zero,
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 272_000 },
                      input: Money.USDPerMillionTokens.make(3),
                      output: Money.USDPerMillionTokens.make(18),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.25),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 200_000 },
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(22.5),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                  ],
                  status: "active",
                  enabled: true,
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                },
                {
                  id: CatalogModel.ID.make("gpt-5.4-fast"),
                  modelID,
                  providerID,
                  name: "GPT-5.4 Fast",
                  family: CatalogModel.Family.make("gpt"),
                  package: Provider.aisdk("@ai-sdk/openai-compatible"),
                  settings: { baseURL: "https://api.acme.test/v1" },
                  headers: { "x-mode": "fast" },
                  body: { service_tier: "priority" },
                  capabilities: { tools: true, input: [], output: [] },
                  variants: [],
                  time: { released: Date.parse("2026-01-01") },
                  cost: [
                    {
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(30),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 272_000 },
                      input: Money.USDPerMillionTokens.make(3),
                      output: Money.USDPerMillionTokens.make(18),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.25),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                    {
                      tier: { type: "context", size: 200_000 },
                      input: Money.USDPerMillionTokens.make(5),
                      output: Money.USDPerMillionTokens.make(22.5),
                      cache: {
                        read: Money.USDPerMillionTokens.make(0.5),
                        write: Money.USDPerMillionTokens.zero,
                      },
                    },
                  ],
                  status: "active",
                  enabled: true,
                  limit: { context: 1_050_000, input: 922_000, output: 128_000 },
                },
              ],
            },
          ] satisfies readonly ModelsDev.Snapshot[]),
        refresh: () => Effect.void,
      })

      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      ).pipe(Effect.provideService(ModelsDev.Service, models))

      const base = yield* catalog.model.get(providerID, CatalogModel.ID.make("gpt-5.4"))
      const fast = yield* catalog.model.get(providerID, CatalogModel.ID.make("gpt-5.4-fast"))

      expect(base?.variants).toEqual([])
      expect(base?.body).toBeUndefined()
      expect(fast).toMatchObject({
        id: "gpt-5.4-fast",
        modelID: "gpt-5.4",
        providerID: "acme",
        name: "GPT-5.4 Fast",
        package: Provider.aisdk("@ai-sdk/openai-compatible"),
        settings: { baseURL: "https://api.acme.test/v1" },
        headers: { "x-mode": "fast" },
        body: { service_tier: "priority" },
        variants: [],
      })
      expect(fast?.cost).toEqual([
        {
          input: Money.USDPerMillionTokens.make(5),
          output: Money.USDPerMillionTokens.make(30),
          cache: {
            read: Money.USDPerMillionTokens.make(0.5),
            write: Money.USDPerMillionTokens.zero,
          },
        },
        {
          tier: { type: "context", size: 272_000 },
          input: Money.USDPerMillionTokens.make(3),
          output: Money.USDPerMillionTokens.make(18),
          cache: {
            read: Money.USDPerMillionTokens.make(0.25),
            write: Money.USDPerMillionTokens.zero,
          },
        },
        {
          tier: { type: "context", size: 200_000 },
          input: Money.USDPerMillionTokens.make(5),
          output: Money.USDPerMillionTokens.make(22.5),
          cache: {
            read: Money.USDPerMillionTokens.make(0.5),
            write: Money.USDPerMillionTokens.zero,
          },
        },
      ])
    }),
  )

  it.effect("registers key methods for providers with environment variables", () =>
    Effect.gen(function* () {
      const integrations = yield* Integration.Service
      const catalog = yield* Catalog.Service
      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      )
      expect(yield* integrations.list()).toEqual([
        Integration.Info.make({
          id: Integration.ID.make("acme"),
          name: "Acme",
          methods: [
            { type: "key" },
            {
              type: "env",
              names: ["ACME_API_KEY"],
            },
          ],
          connections: [],
        }),
      ])
      expect((yield* catalog.provider.get(Provider.ID.make("acme")))?.package).toBe("")
    }).pipe(Effect.provide(models(path.join(import.meta.dir, "fixtures", "models-dev.json")))),
  )

  it.effect("converts reasoning options into settings variants", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* ModelsDevPlugin.effect(
        host({
          catalog: catalogHost(catalog),
          integration: integrationHost(integrations),
        }),
      )

      const model = yield* catalog.model.get(Provider.ID.openai, CatalogModel.ID.make("gpt-reasoning"))
      expect(model?.settings).toEqual({
        baseURL: "https://api.openai.com/v1",
        include: ["reasoning.encrypted_content"],
      })
      expect(model?.variants?.map((variant) => variant.id)).toEqual([
        CatalogModel.VariantID.make("none"),
        CatalogModel.VariantID.make("low"),
        CatalogModel.VariantID.make("high"),
      ])
      expect(model?.variants).toContainEqual({
        id: CatalogModel.VariantID.make("low"),
        settings: {
          reasoningEffort: "low",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      })
      expect(model?.variants).toContainEqual({
        id: CatalogModel.VariantID.make("high"),
        settings: {
          reasoningEffort: "high",
          reasoningSummary: "auto",
          include: ["reasoning.encrypted_content"],
        },
      })

      if (!model) throw new Error("Fixture catalog model missing")
      const selected = yield* SessionRunnerModel.withVariant(model, CatalogModel.VariantID.make("none"))
      expect(selected.settings).toMatchObject({ reasoningEffort: "none", reasoningSummary: "auto" })
      const resolved = yield* SessionRunnerModel.fromCatalogModel(selected, Credential.Key.make({ type: "key", key: "fixture-key" }))
      expect(yield* captureRequestBody(resolved)).toMatchObject({ model: "gpt-reasoning", reasoning: { effort: "none" } })

      const mode = yield* catalog.model.get(Provider.ID.openai, CatalogModel.ID.make("gpt-reasoning-high"))
      expect(mode).toMatchObject({
        id: "gpt-reasoning-high",
        name: "GPT Reasoning High",
        headers: { "x-mode": "high" },
        body: { service_tier: "priority" },
      })
      expect(mode?.variants?.map((variant) => variant.id)).toEqual([
        CatalogModel.VariantID.make("none"),
        CatalogModel.VariantID.make("low"),
        CatalogModel.VariantID.make("high"),
      ])

      const pro = yield* catalog.model.get(Provider.ID.openai, CatalogModel.ID.make("gpt-reasoning-pro"))
      expect(pro).toMatchObject({
        id: "gpt-reasoning-pro",
        body: { reasoning: { mode: "pro" } },
      })

      const budgetModel = yield* catalog.model.get(Provider.ID.anthropic, CatalogModel.ID.make("claude-budget"))
      expect(budgetModel?.settings).toEqual({ baseURL: "https://api.anthropic.com/v1" })
      expect(budgetModel?.variants?.[0]?.settings).not.toHaveProperty("include")
      expect(budgetModel?.variants).toContainEqual({
        id: CatalogModel.VariantID.make("high"),
        settings: { thinking: { type: "enabled", budgetTokens: 16000 } },
      })
      expect(budgetModel?.variants).toContainEqual({
        id: CatalogModel.VariantID.make("max"),
        settings: { thinking: { type: "enabled", budgetTokens: 31999 } },
      })

      const anthropicEffortModel = yield* catalog.model.get(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-4.7"))
      expect(anthropicEffortModel?.variants).toEqual([
        { id: CatalogModel.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
        {
          id: CatalogModel.VariantID.make("low"),
          settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "low" },
        },
      ])

      const anthropicToggleModel = yield* catalog.model.get(Provider.ID.anthropic, CatalogModel.ID.make("claude-toggle"))
      expect(anthropicToggleModel?.variants).toEqual([
        { id: CatalogModel.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
        {
          id: CatalogModel.VariantID.make("thinking"),
          settings: { thinking: { type: "adaptive", display: "summarized" } },
        },
      ])

      const opus45 = yield* catalog.model.get(Provider.ID.anthropic, CatalogModel.ID.make("claude-opus-4-5"))
      expect(opus45?.variants).toEqual([
        { id: CatalogModel.VariantID.make("low"), settings: { effort: "low" } },
        { id: CatalogModel.VariantID.make("high"), settings: { effort: "high" } },
      ])

      const grok = yield* catalog.model.get(Provider.ID.make("xai"), CatalogModel.ID.make("grok-4.5"))
      expect(grok?.variants).toEqual(
        ["low", "medium", "high"].map((id) => ({
          id: CatalogModel.VariantID.make(id),
          settings: { reasoningEffort: id },
        })),
      )

      const minimax = yield* catalog.model.get(Provider.ID.make("opencode-go"), CatalogModel.ID.make("minimax-m3"))
      expect(minimax?.variants).toEqual([
        { id: CatalogModel.VariantID.make("none"), settings: { thinking: { type: "disabled" } } },
        {
          id: CatalogModel.VariantID.make("thinking"),
          settings: { thinking: { type: "adaptive", display: "summarized" } },
        },
      ])

      const toggle = yield* catalog.model.get(Provider.ID.make("alibaba"), CatalogModel.ID.make("toggle-only"))
      expect(toggle?.variants).toEqual([
        { id: CatalogModel.VariantID.make("none"), settings: { enableThinking: false } },
        { id: CatalogModel.VariantID.make("high"), settings: { enableThinking: true } },
      ])

      const combined = yield* catalog.model.get(Provider.ID.make("alibaba"), CatalogModel.ID.make("toggle-budget"))
      expect(combined?.variants).toEqual([
        { id: CatalogModel.VariantID.make("none"), settings: { enableThinking: false } },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { enableThinking: true, thinkingBudget: 8000 },
        },
        {
          id: CatalogModel.VariantID.make("max"),
          settings: { enableThinking: true, thinkingBudget: 16000 },
        },
      ])

      const gateway = yield* catalog.model.get(Provider.ID.make("vercel"), CatalogModel.ID.make("alibaba/qwen-toggle"))
      expect(gateway?.variants).toEqual([
        { id: CatalogModel.VariantID.make("none"), settings: { enableThinking: false } },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { enableThinking: true, thinkingBudget: 8000 },
        },
        {
          id: CatalogModel.VariantID.make("max"),
          settings: { enableThinking: true, thinkingBudget: 16000 },
        },
      ])

      const gatewayNova = yield* catalog.model.get(Provider.ID.make("vercel"), CatalogModel.ID.make("amazon/nova-2-lite"))
      expect(gatewayNova?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("none"),
          settings: { additionalModelRequestFields: { reasoningConfig: { type: "disabled" } } },
        },
        {
          id: CatalogModel.VariantID.make("low"),
          settings: { reasoningConfig: { type: "enabled", maxReasoningEffort: "low" } },
        },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } },
        },
      ])

      const gatewayFallback = yield* catalog.model.get(
        Provider.ID.make("vercel"),
        CatalogModel.ID.make("deepseek/deepseek-toggle"),
      )
      expect(gatewayFallback?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("none"),
          settings: { reasoning: { enabled: false } },
        },
        {
          id: CatalogModel.VariantID.make("low"),
          settings: { reasoningEffort: "low" },
        },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { reasoningEffort: "high" },
        },
      ])

      const openrouter = yield* catalog.model.get(
        Provider.ID.make("openrouter"),
        CatalogModel.ID.make("openrouter-toggle"),
      )
      expect(openrouter?.variants).toEqual([
        { id: CatalogModel.VariantID.make("none"), settings: { reasoning: { enabled: false } } },
        { id: CatalogModel.VariantID.make("thinking"), settings: { reasoning: { enabled: true } } },
      ])

      const google = yield* catalog.model.get(Provider.ID.make("google"), CatalogModel.ID.make("gemini-2.5-flash"))
      expect(google?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("none"),
          settings: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } },
        },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } },
        },
        {
          id: CatalogModel.VariantID.make("max"),
          settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
        },
      ])

      const vertex = yield* catalog.model.get(
        Provider.ID.make("google-vertex"),
        CatalogModel.ID.make("gemini-2.5-flash-lite"),
      )
      expect(vertex?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("none"),
          settings: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } },
        },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } },
        },
        {
          id: CatalogModel.VariantID.make("max"),
          settings: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } },
        },
      ])

      const bedrock = yield* catalog.model.get(
        Provider.ID.make("amazon-bedrock"),
        CatalogModel.ID.make("amazon.nova-2-lite-v1:0"),
      )
      expect(bedrock?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("none"),
          settings: { additionalModelRequestFields: { reasoningConfig: { type: "disabled" } } },
        },
        {
          id: CatalogModel.VariantID.make("low"),
          settings: { reasoningConfig: { type: "enabled", maxReasoningEffort: "low" } },
        },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { reasoningConfig: { type: "enabled", maxReasoningEffort: "high" } },
        },
      ])

      const sapGemini = yield* catalog.model.get(Provider.ID.make("sap-ai-core"), CatalogModel.ID.make("gemini-2.5-flash"))
      expect(sapGemini?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("none"),
          settings: { modelParams: { thinkingConfig: { includeThoughts: false, thinkingBudget: 0 } } },
        },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8000 } } },
        },
        {
          id: CatalogModel.VariantID.make("max"),
          settings: { modelParams: { thinkingConfig: { includeThoughts: true, thinkingBudget: 16000 } } },
        },
      ])

      const sapNova = yield* catalog.model.get(Provider.ID.make("sap-ai-core"), CatalogModel.ID.make("amazon--nova-lite"))
      expect(sapNova?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("none"),
          settings: {
            modelParams: { additionalModelRequestFields: { thinking: { type: "disabled" } } },
          },
        },
        {
          id: CatalogModel.VariantID.make("low"),
          settings: {
            modelParams: { additionalModelRequestFields: { output_config: { effort: "low" } } },
          },
        },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: {
            modelParams: { additionalModelRequestFields: { output_config: { effort: "high" } } },
          },
        },
      ])

      const sapCohere = yield* catalog.model.get(
        Provider.ID.make("sap-ai-core"),
        CatalogModel.ID.make("cohere--command-a-reasoning"),
      )
      expect(sapCohere?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("none"),
          settings: { modelParams: { thinking: { type: "disabled" } } },
        },
        {
          id: CatalogModel.VariantID.make("low"),
          settings: { modelParams: { reasoning_effort: "low" } },
        },
        {
          id: CatalogModel.VariantID.make("high"),
          settings: { modelParams: { reasoning_effort: "high" } },
        },
      ])

      const sapAnthropicEffort = yield* catalog.model.get(
        Provider.ID.make("sap-ai-core"),
        CatalogModel.ID.make("anthropic--claude-4.7-opus"),
      )
      expect(sapAnthropicEffort?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("low"),
          settings: {
            modelParams: {
              additionalModelRequestFields: {
                thinking: { type: "adaptive", display: "summarized" },
                output_config: { effort: "low" },
              },
            },
          },
        },
      ])

      const sapAnthropicBudget = yield* catalog.model.get(
        Provider.ID.make("sap-ai-core"),
        CatalogModel.ID.make("anthropic--claude-4-sonnet"),
      )
      expect(sapAnthropicBudget?.variants).toEqual([
        {
          id: CatalogModel.VariantID.make("high"),
          settings: {
            modelParams: {
              additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 8000 } },
            },
          },
        },
        {
          id: CatalogModel.VariantID.make("max"),
          settings: {
            modelParams: {
              additionalModelRequestFields: { thinking: { type: "enabled", budget_tokens: 16000 } },
            },
          },
        },
      ])
    }).pipe(Effect.provide(models(path.join(import.meta.dir, "fixtures", "models-dev-reasoning.json")))),
  )

  it.effect("ignores parseable models.dev files with an invalid shape", () =>
    Effect.gen(function* () {
      const service = yield* ModelsDev.Service

      expect(yield* service.get()).toEqual([])
    }).pipe(Effect.provide(models(path.join(import.meta.dir, "fixtures", "models-dev-invalid.json")))),
  )
})
