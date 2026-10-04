import { describe, expect, test } from "bun:test"
import { OpenRouterUsage } from "@ycoding-ai/core/provider-usage/openrouter"
import { Provider } from "@ycoding-ai/core/provider"
import { ProviderUsageRuntime } from "@ycoding-ai/core/provider-usage"
import { Credential } from "@ycoding-ai/core/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { Effect } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

const providerID = Provider.ID.make("openrouter")

describe("OpenRouterUsage", () => {
  test("normalizes key usage and remaining allowance without exposing the key", () => {
    const snapshot = OpenRouterUsage.normalizeKey({
      providerID,
      label: "OpenRouter",
      updatedAt: 100,
      response: {
        data: {
          label: "sk-or-v1-secret",
          limit: 100,
          usage: 25.5,
          usage_daily: 1.25,
          usage_weekly: 8.5,
          usage_monthly: 20.25,
          limit_remaining: 74.5,
          limit_reset: "monthly",
          expires_at: "2026-08-01T00:00:00Z",
        },
      },
    })

    expect(snapshot).toMatchObject({
      providerID: "openrouter",
      label: "OpenRouter",
      status: "available",
      source: "provider_api",
      stability: "stable",
      windows: [
        { id: "key", label: "Key Limit", unit: "usd", used: 25.5, limit: 100, remaining: 74.5 },
        { id: "daily", label: "Today", unit: "usd", used: 1.25 },
        { id: "weekly", label: "This Week", unit: "usd", used: 8.5 },
        { id: "monthly", label: "This Month", unit: "usd", used: 20.25 },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain("sk-or-v1-secret")
  })

  test("shows account credits and balance when credits are reported", () => {
    const snapshot = OpenRouterUsage.mergeCredits(
      OpenRouterUsage.normalizeKey({
        providerID,
        label: "OpenRouter",
        updatedAt: 100,
        response: { data: { usage: 5 } },
      }),
      { data: { total_credits: 80, total_usage: 30 } },
    )

    expect(snapshot.windows).toContainEqual(
      expect.objectContaining({ id: "credits", label: "Credits", unit: "usd", used: 30, limit: 80, remaining: 50 }),
    )
    expect(snapshot.windows).toContainEqual(
      expect.objectContaining({ id: "balance", label: "Balance", unit: "usd", remaining: 50 }),
    )
    expect(snapshot.windows.some((window) => window.id === "key")).toBe(false)
  })

  test("key limit uses current-window remaining rather than lifetime usage", () => {
    const snapshot = OpenRouterUsage.normalizeKey({
      providerID, label: "OpenRouter", updatedAt: 100,
      response: { data: { usage: 75, limit: 100, limit_remaining: 40, usage_daily: 0 } },
    })
    expect(snapshot.windows).toMatchObject([
      { id: "key", used: 60, limit: 100, remaining: 40 },
      { id: "daily", used: 0 },
    ])
  })

  test("rejects malformed payloads instead of inventing values", () => {
    expect(() =>
      OpenRouterUsage.normalizeKey({
        providerID,
        label: "OpenRouter",
        updatedAt: 100,
        response: { data: { usage: "unknown" } },
      }),
    ).toThrow("Invalid OpenRouter usage response")
  })

  test("requests credits with an ordinary configured key and keeps key spend on a forbidden balance", async () => {
    const urls: string[] = []
    const http = HttpClient.make((request) => Effect.sync(() => {
      urls.push(request.url)
      return HttpClientResponse.fromWeb(request, request.url.endsWith("/credits")
        ? Response.json({ error: "forbidden" }, { status: 403 })
        : Response.json({ data: { usage: 4, usage_daily: 0, usage_weekly: 2, usage_monthly: 3 } }))
    }))
    const snapshot = await Effect.runPromise(ProviderUsageRuntime.openRouter(http, {
      providerID, label: "OpenRouter", updatedAt: 100,
      credential: new Credential.Info({
        id: Credential.ID.make("cred_openrouter_test"), integrationID: Integration.ID.make("openrouter"),
        label: "default", value: { type: "key", key: "secret-account-key" },
      }),
    }))
    expect(urls).toEqual([
      "https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/credits",
    ])
    expect(snapshot.windows.map((window) => window.id)).toEqual(["daily", "weekly", "monthly"])
    expect(snapshot.status).toBe("available")
    expect(JSON.stringify(snapshot)).not.toContain("secret-account-key")
  })

  test("loads a balance and credits meter with a normal non-management key", async () => {
    const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request,
      Response.json(request.url.endsWith("/credits")
        ? { data: { total_credits: 80, total_usage: 30 } }
        : { data: { usage_daily: 0, usage_weekly: 8, usage_monthly: 20 } }),
    )))
    const snapshot = await Effect.runPromise(ProviderUsageRuntime.openRouter(http, {
      providerID, label: "OpenRouter", updatedAt: 100,
      credential: new Credential.Info({
        id: Credential.ID.make("cred_openrouter_key"), integrationID: Integration.ID.make("openrouter"),
        label: "default", value: { type: "key", key: "normal-key" },
      }),
    }))
    expect(snapshot.windows).toMatchObject([
      { id: "daily", used: 0 }, { id: "weekly", used: 8 }, { id: "monthly", used: 20 },
      { id: "credits", used: 30, limit: 80, remaining: 50 }, { id: "balance", remaining: 50 },
    ])
  })

  test("keeps account credits when a management key cannot read current-key spend", async () => {
    const http = HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request,
      request.url.endsWith("/key")
        ? Response.json({ error: "forbidden" }, { status: 403 })
        : Response.json({ data: { total_credits: 10, total_usage: 3 } }),
    )))
    const snapshot = await Effect.runPromise(ProviderUsageRuntime.openRouter(http, {
      providerID, label: "OpenRouter", updatedAt: 100,
      credential: new Credential.Info({
        id: Credential.ID.make("cred_openrouter_management"), integrationID: Integration.ID.make("openrouter"),
        label: "management", value: { type: "key", key: "secret-management-key" },
      }),
    }))
    expect(snapshot).toMatchObject({ status: "available", windows: [
      { id: "credits", used: 3, limit: 10, remaining: 7 }, { id: "balance", remaining: 7 },
    ] })
  })
})
