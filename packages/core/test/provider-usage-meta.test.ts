import { describe, expect, test } from "bun:test"
import { MetaUsage } from "@ycoding-ai/core/provider-usage/meta"
import { ProviderV2 } from "@ycoding-ai/core/provider"

const providerID = ProviderV2.ID.make("meta")

describe("MetaUsage", () => {
  test("normalizes reported current-month costs into the current bill and preserves request and token windows", () => {
    const monthStart = Date.UTC(2026, 7, 1) / 1000
    const weekStart = Date.UTC(2026, 7, 3) / 1000
    const snapshot = MetaUsage.normalize({
      providerID,
      label: "Meta Model API",
      updatedAt: Date.UTC(2026, 7, 5),
      weekStart,
      monthStart,
      usage: [
        {
          start_time: Date.UTC(2026, 7, 4) / 1000,
          end_time: Date.UTC(2026, 7, 5) / 1000,
          results: [{ input_tokens: 100, output_tokens: 50, num_model_requests: 2 }],
        },
        {
          start_time: Date.UTC(2026, 7, 2) / 1000,
          end_time: Date.UTC(2026, 7, 3) / 1000,
          results: [{ input_tokens: 30, output_tokens: 5, num_model_requests: 1 }],
        },
      ],
      costs: [
        {
          start_time: Date.UTC(2026, 7, 4) / 1000,
          end_time: Date.UTC(2026, 7, 5) / 1000,
          results: [{ amount: { value: 2.5, currency: "usd" } }],
        },
        {
          start_time: Date.UTC(2026, 7, 2) / 1000,
          end_time: Date.UTC(2026, 7, 3) / 1000,
          results: [{ amount: { value: 1.25, currency: "usd" } }],
        },
        {
          start_time: Date.UTC(2026, 6, 31) / 1000,
          end_time: Date.UTC(2026, 7, 1) / 1000,
          results: [{ amount: { value: 9, currency: "usd" } }],
        },
      ],
    })

    expect(snapshot).toMatchObject({
      providerID: "meta",
      status: "available",
      source: "provider_api",
      stability: "stable",
      windows: [
        {
          id: "current-bill",
          label: "Current bill",
          unit: "usd",
          used: 3.75,
          resetAt: Date.UTC(2026, 8, 1),
        },
        { id: "week-requests", unit: "requests", used: 2 },
        { id: "month-requests", unit: "requests", used: 3 },
        { id: "week-tokens", unit: "tokens", used: 150 },
        { id: "month-tokens", unit: "tokens", used: 185 },
      ],
    })
    expect(
      snapshot.windows.some((window) => window.id === "week-cost" || window.id === "month-cost"),
    ).toBe(false)
  })

  test("keeps unreported bill amounts and unverified billing dates absent", () => {
    const monthStart = Date.UTC(2026, 7, 1) / 1000
    const unreported = MetaUsage.normalize({
      providerID,
      label: "Meta Model API",
      updatedAt: Date.UTC(2026, 7, 5),
      weekStart: monthStart,
      monthStart,
      usage: [],
      costs: [],
    }).windows.find((window) => window.id === "current-bill")
    const unverifiedDate = MetaUsage.normalize({
      providerID,
      label: "Meta Model API",
      updatedAt: 300_000,
      weekStart: 100,
      monthStart: 100,
      usage: [],
      costs: [
        { start_time: 200, end_time: 300, results: [{ amount: { value: 1.25, currency: "usd" } }] },
      ],
    }).windows.find((window) => window.id === "current-bill")

    expect(unreported).toMatchObject({ id: "current-bill", unit: "usd" })
    expect(unreported?.used).toBeUndefined()
    expect(unreported?.resetAt).toBeUndefined()
    expect(unverifiedDate).toMatchObject({ id: "current-bill", unit: "usd", used: 1.25 })
    expect(unverifiedDate?.resetAt).toBeUndefined()
  })
})
