import { describe, expect, test } from "bun:test"
import { OpenAIUsage } from "@ycoding-ai/core/provider-usage/openai"
import { Provider } from "@ycoding-ai/core/provider"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/core/integration"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { EventRuntime } from "@ycoding-ai/core/event"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { testEffect } from "./lib/effect"

const providerID = Provider.ID.make("openai")
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Integration.node, Credential.node, EventRuntime.node])))

describe("OpenAIUsage", () => {
  for (const admin of [false, true])
    test(`uses organization endpoints only for an explicitly marked admin API key (${admin})`, async () => {
      const urls: string[] = []
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          urls.push(request.url.split("?")[0]!)
          return HttpClientResponse.fromWeb(request, Response.json({ data: [], has_more: false }))
        }),
      )
      const snapshot = await Effect.runPromise(
        ProviderUsageRuntime.openAI(
          http,
          {
            providerID,
            label: "OpenAI API",
            updatedAt: Date.UTC(2026, 9, 10),
            credential: new Credential.Info({
              id: Credential.ID.make("cred_openai_api_usage"),
              integrationID: Integration.ID.make("openai"),
              label: "default",
              value: Credential.Key.make({ type: "key", key: "fixture-key", metadata: { usageAdmin: admin } }),
            }),
          },
          { snapshot: () => Effect.die("API keys must not resolve ChatGPT OAuth") },
        ),
      )
      expect(snapshot).toMatchObject({
        status: admin ? "available" : "unauthorized",
        source: "provider_api",
        stability: "stable",
      })
      expect(urls).toEqual(
        admin
          ? ["https://api.openai.com/v1/organization/usage/completions", "https://api.openai.com/v1/organization/costs"]
          : [],
      )
    })

  test("keeps ChatGPT rejection source labels, safe diagnostics and stale quota without API fallback", async () => {
    const credential = new Credential.Info({
      id: Credential.ID.make("cred_openai_usage"),
      integrationID: Integration.ID.make("openai"),
      label: "default",
      value: Credential.OAuth.make({
        type: "oauth",
        methodID: Integration.MethodID.make("chatgpt-browser"),
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 600_000,
      }),
    })
    let status = 403
    const urls: string[] = []
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        urls.push(request.url)
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            status === 200
              ? { rate_limit: { secondary_window: { used_percent: 25 } } }
              : { error: "fixture-private-upstream-error" },
            { status },
          ),
        )
      }),
    )
    const usage = ProviderUsageRuntime.make({
      credentials: { all: () => Effect.succeed([credential]) },
      providers: { available: () => Effect.succeed([{ id: providerID }]) },
      adapters: {
        openai: (input) =>
          ProviderUsageRuntime.openAI(http, input, {
            snapshot: (connection) => Effect.succeed({ connection, credential, value: credential.value }),
          }),
      },
    })
    const rejected = await Effect.runPromise(usage.get({ providerID, refresh: true }))
    expect(rejected).toMatchObject({
      status: "unauthorized",
      source: "provider_internal_api",
      stability: "best_effort",
      windows: [],
      message: "Provider usage credentials are unauthorized",
    })
    expect(JSON.stringify(rejected)).not.toContain("fixture-")
    status = 200
    expect((await Effect.runPromise(usage.get({ providerID, refresh: true }))).windows).toMatchObject([{ used: 25 }])
    status = 401
    const stale = await Effect.runPromise(usage.get({ providerID, refresh: true }))
    expect(stale).toMatchObject({
      status: "stale",
      source: "provider_internal_api",
      stability: "best_effort",
      windows: [{ used: 25 }],
    })
    expect(urls).toEqual(Array(3).fill("https://chatgpt.com/backend-api/wham/usage"))
  })

  it.effect(
    "refreshes expired ChatGPT OAuth through the model credential boundary and never calls organization APIs",
    () =>
      Effect.gen(function* () {
        const integrations = yield* Integration.Service
        const credentials = yield* Credential.Service
        const value = Credential.OAuth.make({
          type: "oauth",
          methodID: Integration.MethodID.make("chatgpt-headless"),
          access: "fixture-expired",
          refresh: "fixture-refresh",
          expires: 0,
          metadata: { accountID: "fixture-account" },
        })
        const credential = yield* credentials.create({ integrationID: Integration.ID.make("openai"), value })
        let refreshes = 0
        yield* integrations.transform((editor) =>
          editor.method.update({
            integrationID: credential.integrationID,
            method: { id: value.methodID, type: "oauth", label: "ChatGPT" },
            authorize: () => Effect.die("unused login"),
            refresh: () =>
              Effect.sync(() => {
                refreshes++
                return Credential.OAuth.make({
                  ...value,
                  access: "fixture-fresh",
                  refresh: "fixture-rotated",
                  expires: 600_000,
                })
              }),
          }),
        )
        const urls: string[] = []
        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            urls.push(request.url)
            if (request.headers.authorization !== "Bearer fixture-fresh")
              return HttpClientResponse.fromWeb(request, Response.json({}, { status: 401 }))
            expect(request.headers["chatgpt-account-id"]).toBe("fixture-account")
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                plan_type: "plus",
                rate_limit: {
                  secondary_window: { used_percent: 12, limit_window_seconds: 604800 },
                },
              }),
            )
          }),
        )
        const usage = ProviderUsageRuntime.make({
          credentials,
          providers: { available: () => Effect.succeed([{ id: providerID }]) },
          adapters: { openai: (input) => ProviderUsageRuntime.openAI(http, input, integrations.connection) },
        })
        const snapshot = yield* usage.get({ providerID, refresh: true })
        expect(snapshot).toMatchObject({
          status: "available",
          label: "Codex Plus",
          source: "provider_internal_api",
          stability: "best_effort",
          windows: [{ label: "Weekly", used: 12 }],
        })
        expect(refreshes).toBe(1)
        expect(urls).toEqual(["https://chatgpt.com/backend-api/wham/usage"])
        expect((yield* credentials.get(credential.id))?.generation).toBe(1)
        expect(JSON.stringify(snapshot)).not.toContain("fixture-")
      }),
  )

  test("aggregates documented organization usage and cost buckets", () => {
    const snapshot = OpenAIUsage.normalize({
      providerID,
      label: "OpenAI API",
      updatedAt: 100,
      weekStart: 1_000,
      monthStart: 100,
      usage: [
        {
          start_time: 1_100,
          end_time: 1_200,
          results: [
            { input_tokens: 100, output_tokens: 50, num_model_requests: 2 },
            { input_tokens: 20, output_tokens: 10, num_model_requests: 1 },
          ],
        },
        {
          start_time: 500,
          end_time: 600,
          results: [{ input_tokens: 30, output_tokens: 5, num_model_requests: 1 }],
        },
      ],
      costs: [
        { start_time: 1_100, end_time: 1_200, results: [{ amount: { value: 2.5, currency: "usd" } }] },
        { start_time: 500, end_time: 600, results: [{ amount: { value: 1.25, currency: "usd" } }] },
      ],
    })

    expect(snapshot).toMatchObject({
      providerID: "openai",
      status: "available",
      source: "provider_api",
      stability: "stable",
      windows: [
        { id: "week-cost", unit: "usd", used: 2.5 },
        { id: "month-cost", unit: "usd", used: 3.75 },
        { id: "week-requests", unit: "requests", used: 3 },
        { id: "month-requests", unit: "requests", used: 4 },
        { id: "week-tokens", unit: "tokens", used: 180 },
        { id: "month-tokens", unit: "tokens", used: 215 },
      ],
    })
  })

  test("recognizes only explicitly marked admin credentials", () => {
    expect(OpenAIUsage.isAdminCredential({ usageAdmin: true })).toBe(true)
    expect(OpenAIUsage.isAdminCredential({ usage_admin: true })).toBe(true)
    expect(OpenAIUsage.isAdminCredential({ admin: true })).toBe(false)
    expect(OpenAIUsage.isAdminCredential(undefined)).toBe(false)
  })

  test("rejects non-USD cost results", () => {
    expect(() =>
      OpenAIUsage.normalize({
        providerID,
        label: "OpenAI API",
        updatedAt: 100,
        weekStart: 1,
        monthStart: 1,
        usage: [],
        costs: [{ start_time: 1, end_time: 2, results: [{ amount: { value: 1, currency: "eur" } }] }],
      }),
    ).toThrow("Unsupported OpenAI cost currency")
  })
})
