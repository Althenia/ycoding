import { describe, expect, test } from "bun:test"
import { OpenRouterUsage } from "@ycoding-ai/core/provider-usage/openrouter"
import { ProviderV2 } from "@ycoding-ai/core/provider"

const providerID = ProviderV2.ID.make("openrouter")

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
        { id: "key", unit: "usd", used: 25.5, limit: 100, remaining: 74.5 },
        { id: "daily", unit: "usd", used: 1.25 },
        { id: "weekly", unit: "usd", used: 8.5 },
        { id: "monthly", unit: "usd", used: 20.25 },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain("sk-or-v1-secret")
  })

  test("merges documented account credits when a management response exists", () => {
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
})
