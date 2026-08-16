import { describe, expect, test } from "bun:test"
import { ClaudeUsage } from "@ycoding-ai/core/provider-usage/claude"
import { ProviderV2 } from "@ycoding-ai/core/provider"

const providerID = ProviderV2.ID.make("anthropic")

describe("ClaudeUsage", () => {
  test("normalizes unified response headers as live percentages", () => {
    const snapshot = ClaudeUsage.normalizeHeaders({
      providerID,
      label: "Claude Pro",
      observedAt: 100,
      headers: new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.42",
        "anthropic-ratelimit-unified-5h-reset": "1785200000",
        "anthropic-ratelimit-unified-7d-utilization": "0.18",
        "anthropic-ratelimit-unified-7d-reset": "1785600000",
        "anthropic-ratelimit-unified-overage-status": "allowed",
        "anthropic-ratelimit-unified-overage-utilization": "0.05",
      }),
    })

    expect(snapshot).toMatchObject({
      status: "available",
      source: "response_headers",
      stability: "observed",
      windows: [
        { id: "five-hour", unit: "percent", used: 42, resetAt: 1_785_200_000_000 },
        { id: "seven-day", unit: "percent", used: 18, resetAt: 1_785_600_000_000 },
        { id: "overage", unit: "percent", used: 5 },
      ],
    })
  })

  test("normalizes OAuth windows, model lanes, and extra usage credits", () => {
    const snapshot = ClaudeUsage.normalizeOAuth({
      providerID,
      label: "Claude Max",
      updatedAt: 100,
      response: {
        five_hour: { utilization: 86, resets_at: "2026-07-28T00:00:00Z" },
        seven_day: { utilization: 27, resets_at: "2026-08-01T00:00:00Z" },
        seven_day_sonnet: { utilization: 45, resets_at: "2026-08-01T00:00:00Z" },
        extra_usage: { is_enabled: true, monthly_limit: 10000, used_credits: 5666, utilization: 56.66 },
      },
    })

    expect(snapshot).toMatchObject({
      source: "provider_internal_api",
      stability: "best_effort",
      windows: [
        { id: "five-hour", used: 86 },
        { id: "seven-day", used: 27 },
        { id: "seven-day-sonnet", label: "Sonnet weekly", used: 45 },
        { id: "extra-usage", unit: "usd", used: 56.66, limit: 100, remaining: 43.34 },
      ],
    })
  })

  test("lets newer live headers replace overlapping OAuth windows", () => {
    const oauth = ClaudeUsage.normalizeOAuth({
      providerID,
      label: "Claude Pro",
      updatedAt: 100,
      response: {
        five_hour: { utilization: 30, resets_at: "2026-07-28T00:00:00Z" },
        seven_day_sonnet: { utilization: 20, resets_at: "2026-08-01T00:00:00Z" },
      },
    })
    const live = ClaudeUsage.normalizeHeaders({
      providerID,
      label: "Claude Pro",
      observedAt: 200,
      headers: new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.55" }),
    })

    expect(ClaudeUsage.merge(live, oauth)).toMatchObject({
      updatedAt: 200,
      source: "response_headers",
      windows: [
        { id: "five-hour", used: 55 },
        { id: "seven-day-sonnet", used: 20 },
      ],
    })
  })

  test("retries OAuth usage once after a forced credential refresh", async () => {
    const tokens: string[] = []
    let refreshed = 0
    const snapshot = await ClaudeUsage.loadOAuth({
      providerID,
      label: "Claude Pro",
      updatedAt: 100,
      resolve: async () => ({ accessToken: "expired" }),
      refresh: async () => {
        refreshed += 1
        return { accessToken: "rotated" }
      },
      request: (token) => {
        tokens.push(token)
        return Promise.resolve(
          token === "expired"
            ? { status: 401, body: { error: "expired" } }
            : { status: 200, body: { five_hour: { utilization: 42 } } },
        )
      },
    })

    expect(snapshot).toMatchObject({ windows: [{ id: "five-hour", used: 42 }] })
    expect(tokens).toEqual(["expired", "rotated"])
    expect(refreshed).toBe(1)
  })

  test("preserves provider status and retry delay when OAuth usage fails", async () => {
    await expect(
      ClaudeUsage.loadOAuth({
        providerID,
        label: "Claude Pro",
        updatedAt: 100,
        resolve: async () => ({ accessToken: "token" }),
        refresh: async () => null,
        request: async () => ({ status: 429, retryAfter: 90, body: { error: "limited" } }),
      }),
    ).rejects.toMatchObject({ _tag: "ClaudeUsage.RequestError", status: 429, retryAfter: 90 })
  })

  test("computes live utilization from limit and remaining headers", () => {
    expect(
      ClaudeUsage.normalizeHeaders({
        providerID,
        label: "Claude Pro",
        observedAt: 100,
        headers: new Headers({
          "anthropic-ratelimit-unified-5h-limit": "100",
          "anthropic-ratelimit-unified-5h-remaining": "25",
        }),
      }),
    ).toMatchObject({ windows: [{ id: "five-hour", used: 75 }] })
  })

  test("rejects malformed utilization instead of inventing a percentage", () => {
    expect(() =>
      ClaudeUsage.normalizeHeaders({
        providerID,
        label: "Claude Pro",
        observedAt: 100,
        headers: new Headers({ "anthropic-ratelimit-unified-5h-utilization": "unknown" }),
      }),
    ).toThrow("Invalid Claude usage")
  })
})
