import { describe, expect, test } from "bun:test"
import { CodexUsage } from "@ycoding-ai/core/provider-usage/codex"
import { ProviderV2 } from "@ycoding-ai/core/provider"
import { Credential } from "@ycoding-ai/schema/credential"
import { Integration } from "@ycoding-ai/schema/integration"

const providerID = ProviderV2.ID.make("openai")

describe("CodexUsage", () => {
  test("normalizes app-server limits, credits, reset credits, and Spark separately", () => {
    const snapshot = CodexUsage.normalize({
      providerID,
      label: "Codex Plus",
      updatedAt: 100,
      source: "local_client_rpc",
      stability: "client_contract",
      response: {
        result: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_790_000_000 },
            secondary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1_790_500_000 },
            credits: { hasCredits: true, unlimited: false, balance: "18.50" },
            planType: "plus",
          },
          rateLimitsByLimitId: {
            "codex-spark": {
              limitId: "codex-spark",
              primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_790_000_000 },
              secondary: null,
            },
          },
          rateLimitResetCredits: { availableCount: 2, credits: [] },
        },
      },
    })

    expect(snapshot).toMatchObject({
      source: "local_client_rpc",
      stability: "client_contract",
      windows: [
        { id: "codex-primary", label: "5-hour", used: 25, resetAt: 1_790_000_000_000 },
        { id: "codex-secondary", label: "Weekly", used: 18, resetAt: 1_790_500_000_000 },
        { id: "codex-credits", label: "Credits", unit: "usd", remaining: 18.5 },
        { id: "codex-spark-primary", label: "Spark 5-hour", used: 7 },
        { id: "reset-credits", unit: "count", remaining: 2 },
      ],
    })
  })

  test("uses the official app-server initialization and rate-limit RPC sequence", async () => {
    const calls: Array<{ type: "call" | "notify"; method: string; params?: unknown }> = []
    const snapshot = await CodexUsage.loadAppServer({
      providerID,
      label: "Codex Plus",
      updatedAt: 100,
      client: {
        call: async (method, params) => {
          calls.push({ type: "call", method, ...(params === undefined ? {} : { params }) })
          if (method === "initialize") return { userAgent: "codex", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" }
          return {
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_790_000_000 },
            },
          }
        },
        notify: async (method, params) => {
          calls.push({ type: "notify", method, ...(params === undefined ? {} : { params }) })
        },
        close: async () => undefined,
      },
    })

    expect(calls).toEqual([
      {
        type: "call",
        method: "initialize",
        params: { clientInfo: { name: "ycoding", title: "YCoding", version: "1" } },
      },
      { type: "notify", method: "initialized" },
      { type: "call", method: "account/rateLimits/read" },
    ])
    expect(snapshot).toMatchObject({
      source: "local_client_rpc",
      stability: "client_contract",
      windows: [{ id: "codex-primary", used: 25 }],
    })
  })

  test("closes the app-server client when the RPC fails", async () => {
    let closed = 0
    await expect(
      CodexUsage.loadAppServer({
        providerID,
        label: "Codex",
        updatedAt: 100,
        client: {
          call: async () => {
            throw new Error("rpc failed")
          },
          notify: async () => undefined,
          close: async () => {
            closed += 1
          },
        },
      }),
    ).rejects.toThrow("rpc failed")
    expect(closed).toBe(1)
  })

  test("normalizes native backend snake_case fields", () => {
    const snapshot = CodexUsage.normalize({
      providerID,
      label: "Codex Pro",
      updatedAt: 100,
      source: "provider_internal_api",
      stability: "best_effort",
      response: {
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 31, window_duration_mins: 300, resets_at: 1_790_000_000 },
          secondary: { used_percent: 12, window_duration_mins: 10080, resets_at: 1_790_500_000 },
          credits: { has_credits: true, unlimited: true },
          plan_type: "pro",
        },
      },
    })

    expect(snapshot).toMatchObject({
      source: "provider_internal_api",
      stability: "best_effort",
      windows: [
        { id: "codex-primary", used: 31 },
        { id: "codex-secondary", used: 12 },
        { id: "codex-credits", unlimited: true },
      ],
    })
  })

  test("preserves unknown additional limit IDs instead of discarding them", () => {
    const snapshot = CodexUsage.normalize({
      providerID,
      label: "Codex",
      updatedAt: 100,
      source: "local_client_rpc",
      stability: "client_contract",
      response: {
        rateLimits: { primary: null, secondary: null },
        rateLimitsByLimitId: {
          "future-lane": {
            primary: { usedPercent: 40, windowDurationMins: 60, resetsAt: 1_790_000_000 },
          },
        },
      },
    })

    expect(snapshot.windows).toContainEqual(
      expect.objectContaining({ id: "future-lane-primary", label: "Future Lane primary", used: 40 }),
    )
  })

  test("identifies ChatGPT OAuth credentials and account routing", () => {
    const credential = Credential.OAuth.make({
      type: "oauth",
      methodID: Integration.MethodID.make("chatgpt-browser"),
      access: "secret-access-token",
      refresh: "secret-refresh-token",
      expires: 100,
      metadata: { accountID: "acct_123" },
    })

    expect(CodexUsage.isChatGPTCredential(credential)).toBe(true)
    expect(CodexUsage.accountHeaders(credential)).toEqual({
      Authorization: "Bearer secret-access-token",
      "ChatGPT-Account-ID": "acct_123",
    })
  })

  test("rejects invalid percentages", () => {
    expect(() =>
      CodexUsage.normalize({
        providerID,
        label: "Codex",
        updatedAt: 100,
        source: "local_client_rpc",
        stability: "client_contract",
        response: { rateLimits: { primary: { usedPercent: 120, windowDurationMins: 300 } } },
      }),
    ).toThrow("Invalid Codex usage")
  })
})
