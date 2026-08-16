import { describe, expect, test } from "bun:test"
import { OpenAIUsage } from "@ycoding-ai/core/provider-usage/openai"
import { ProviderV2 } from "@ycoding-ai/core/provider"

const providerID = ProviderV2.ID.make("openai")

describe("OpenAIUsage", () => {
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
