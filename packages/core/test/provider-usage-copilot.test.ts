import { describe, expect, test } from "bun:test"
import { CopilotUsage } from "@ycoding-ai/core/provider-usage/copilot"
import { ProviderV2 } from "@ycoding-ai/core/provider"

const providerID = ProviderV2.ID.make("github-copilot")
const userStatusPath = "/copilot_internal/user"
const orgsPath = "/user/orgs"
const summaryPath = (org: string) => `/orgs/${org}/settings/billing/usage/summary`

describe("CopilotUsage", () => {
  test("normalizes paid-tier quota snapshots into percent windows with reset and overage", () => {
    const snapshot = CopilotUsage.normalizeQuota({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        copilot_plan: "INDIVIDUAL",
        quota_reset_date: "2026-08-01T00:00:00Z",
        quota_snapshots: {
          chat: { entitlement: 400, remaining: 220, percent_remaining: 55, overage_count: 12, overage_permitted: true },
          completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100 },
          premium_interactions: { entitlement: 1000000, remaining: 999999, percent_remaining: 99, overage_count: 7, unlimited: false },
        },
      },
    })

    expect(snapshot).toMatchObject({
      label: "GitHub Copilot",
      status: "available",
      source: "provider_internal_api",
      stability: "best_effort",
      windows: [
        { id: "chat", label: "Chat", unit: "percent", used: 45, remaining: 220, limit: 400, resetAt: Date.parse("2026-08-01T00:00:00Z") },
        { id: "chat-overage", label: "Chat overage", unit: "count", used: 12 },
        { id: "completions", label: "Completions", unit: "percent", used: 0, remaining: 2000, limit: 2000 },
        { id: "premium_interactions", label: "Premium requests", unit: "percent", used: 1 },
        { id: "premium_interactions-overage", label: "Premium requests overage", unit: "count", used: 7 },
      ],
    })
  })

  test("derives used percent from entitlement and remaining when percent_remaining is absent", () => {
    const snapshot = CopilotUsage.normalizeQuota({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        quota_snapshots: { chat: { entitlement: 200, remaining: 50 } },
      },
    })

    expect(snapshot.windows).toMatchObject([{ id: "chat", used: 75, limit: 200, remaining: 50 }])
  })

  test("marks unlimited lanes without inventing a percentage", () => {
    const snapshot = CopilotUsage.normalizeQuota({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        quota_reset_date_utc: "2026-08-01T00:00:00Z",
        quota_snapshots: {
          chat: { unlimited: true, remaining: 999999, entitlement: 1000000 },
          completions: { unlimited: true },
        },
      },
    })

    expect(snapshot.windows).toMatchObject([
      { id: "chat", unlimited: true, remaining: 999999, limit: 1000000, resetAt: Date.parse("2026-08-01T00:00:00Z") },
      { id: "completions", unlimited: true },
    ])
    expect(snapshot.windows[0]?.used).toBeUndefined()
  })

  test("normalizes the free limited-user tier into count windows", () => {
    const snapshot = CopilotUsage.normalizeQuota({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        limited_user_quotas: { chat_completion: 50, code_completion: 300 },
        monthly_quotas: { chat_completion: 50, code_completion: 300 },
        limited_user_reset_date: "2026-08-01T00:00:00Z",
      },
    })

    expect(snapshot).toMatchObject({
      source: "provider_internal_api",
      stability: "best_effort",
      windows: [
        { id: "chat_completion", label: "Chat completions", unit: "count", remaining: 50, resetAt: Date.parse("2026-08-01T00:00:00Z") },
        { id: "code_completion", label: "Code completions", unit: "count", remaining: 300 },
      ],
    })
    expect(snapshot.windows).toHaveLength(2)
  })

  test("keeps a missing quota lane fully absent instead of coercing it to zero", () => {
    const snapshot = CopilotUsage.normalizeQuota({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        quota_snapshots: {
          chat: { entitlement: 400, remaining: 220, percent_remaining: 55 },
          completions: {},
        },
      },
    })

    expect(snapshot.windows.map((window) => window.id)).toEqual(["chat"])
    expect(snapshot.windows[0]).toMatchObject({ id: "chat", used: 45, remaining: 220, limit: 400 })
  })

  test("rejects a malformed quota response through Schema decode", () => {
    expect(() =>
      CopilotUsage.normalizeQuota({
        providerID,
        label: "GitHub Copilot",
        updatedAt: 100,
        response: { quota_snapshots: { chat: { percent_remaining: "half" } } },
      }),
    ).toThrow("Invalid Copilot usage response")
    expect(() =>
      CopilotUsage.normalizeQuota({
        providerID,
        label: "GitHub Copilot",
        updatedAt: 100,
        response: { quota_snapshots: "not-a-record" },
      }),
    ).toThrow("Invalid Copilot usage response")
  })

  test("falls back to org billing when the seat reports token-based billing", async () => {
    const calls: string[] = []
    const result = await CopilotUsage.load({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      request: async (path) => {
        calls.push(path)
        if (path === userStatusPath)
          return {
            status: 200,
            body: {
              copilot_plan: "BUSINESS",
              access_type_sku: "token_based_billing",
              quota_reset_date: "2026-08-01T00:00:00Z",
              quota_snapshots: { chat: { entitlement: 0, remaining: 0, percent_remaining: 0 } },
            },
          }
        if (path === orgsPath) return { status: 200, body: [{ login: "acme" }, { login: "globex" }] }
        if (path === summaryPath("acme"))
          return {
            status: 200,
            body: {
              organization: "acme",
              usageItems: [
                { product: "Actions", sku: "actions_minutes", unitType: "Minutes", pricePerUnit: 0.001, grossQuantity: 500, grossAmount: 0.5 },
              ],
            },
          }
        if (path === summaryPath("globex"))
          return {
            status: 200,
            body: {
              organization: "globex",
              usageItems: [
                { aic_quantity: 1234, aic_gross_amount: 12.34 },
              ],
            },
          }
        return { status: 404, body: null }
      },
    })

    expect(calls).toEqual([userStatusPath, orgsPath, summaryPath("acme"), summaryPath("globex")])
    expect(result.matchedOrg).toBe("globex")
    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({
        id: "monthly-ai-credits",
        label: "Monthly AI credits",
        unit: "count",
        used: 1234,
        resetAt: Date.parse("2026-08-01T00:00:00Z"),
      }),
    ])
    expect(result.snapshot.windows[0]?.limit).toBeUndefined()
  })

  test("reuses the remembered org and skips discovery while it answers", async () => {
    const calls: string[] = []
    const result = await CopilotUsage.load({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      matchedOrg: "globex",
      request: async (path) => {
        calls.push(path)
        if (path === userStatusPath)
          return { status: 200, body: { access_type_sku: "token_based_billing" } }
        if (path === summaryPath("globex"))
          return {
            status: 200,
            body: {
              usageItems: [
                { aic_quantity: 77, aic_gross_amount: 0.77 },
              ],
            },
          }
        throw new Error(`unexpected request: ${path}`)
      },
    })

    expect(calls).toEqual([userStatusPath, summaryPath("globex")])
    expect(result.matchedOrg).toBe("globex")
  })

  test("re-discovers the org after the remembered one stops answering", async () => {
    const result = await CopilotUsage.load({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      matchedOrg: "globex",
      request: async (path) => {
        if (path === userStatusPath) return { status: 200, body: { access_type_sku: "token_based_billing" } }
        if (path === summaryPath("globex")) return { status: 404, body: null }
        if (path === orgsPath) return { status: 200, body: [{ login: "acme" }] }
        if (path === summaryPath("acme"))
          return {
            status: 200,
            body: {
              usageItems: [
                { aic_quantity: 5, aic_gross_amount: 0.05 },
              ],
            },
          }
        return { status: 404, body: null }
      },
    })

    expect(result.matchedOrg).toBe("acme")
    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({ id: "monthly-ai-credits", used: 5 }),
    ])
  })

  test("reports nothing when no org answers, leaving windows absent", async () => {
    const result = await CopilotUsage.load({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      request: async (path) => {
        if (path === userStatusPath) return { status: 200, body: { access_type_sku: "token_based_billing" } }
        if (path === orgsPath) return { status: 200, body: [{ login: "acme" }] }
        if (path === summaryPath("acme"))
          return {
            status: 200,
            body: {
              usageItems: [{ product: "Actions", sku: "actions_minutes", unitType: "Minutes", pricePerUnit: 0.001, netQuantity: 50, netAmount: 0.05 }],
            },
          }
        return { status: 404, body: null }
      },
    })

    expect(result.matchedOrg).toBeUndefined()
    expect(result.snapshot).toMatchObject({ status: "available", windows: [] })
  })

  test("normalizes billed credits without a reset when user status is unavailable", () => {
    expect(CopilotUsage.CREDIT_TO_USD).toBe(0.01)
    const result = CopilotUsage.normalizeBilling({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        usageItems: [
          { aic_quantity: 1234 },
        ],
      },
    })

    expect(result.matched).toBe(true)
    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({
        id: "monthly-ai-credits",
        label: "Monthly AI credits",
        unit: "count",
        used: 1234,
      }),
    ])
    expect(result.snapshot.windows[0]?.resetAt).toBeUndefined()
  })

  test("reads official AI-credit usage-report columns", () => {
    const result = CopilotUsage.normalizeBilling({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        usageItems: [{ aic_quantity: 1234, aic_gross_amount: 12.34 }],
      },
    })

    expect(result.matched).toBe(true)
    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({ id: "monthly-ai-credits", unit: "count", used: 1234 }),
    ])
  })

  test("keeps the monthly credit window when the matched entry reports no quantity", () => {
    const result = CopilotUsage.normalizeBilling({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        usageItems: [{ aic_gross_amount: 2.0 }],
      },
    })

    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({ id: "monthly-ai-credits", unit: "count" }),
    ])
    expect(result.snapshot.windows[0]?.used).toBeUndefined()
  })

  test("rejects a malformed org billing payload instead of guessing", () => {
    expect(() =>
      CopilotUsage.normalizeBilling({
        providerID,
        label: "GitHub Copilot",
        updatedAt: 100,
        response: { usageItems: "not-an-array" },
      }),
    ).toThrow("Invalid Copilot usage response")
  })

  test("preserves provider status when the user-status request fails", async () => {
    await expect(
      CopilotUsage.load({
        providerID,
        label: "GitHub Copilot",
        updatedAt: 100,
        request: async () => ({ status: 429, body: { message: "limited" } }),
      }),
    ).rejects.toMatchObject({ _tag: "CopilotUsage.RequestError", status: 429 })
  })

  test("loads a paid-tier quota snapshot through the user-status endpoint", async () => {
    const result = await CopilotUsage.load({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      request: async (path) => {
        if (path !== userStatusPath) throw new Error(`unexpected request: ${path}`)
        return {
          status: 200,
          body: {
            copilot_plan: "INDIVIDUAL",
            quota_reset_date: "2026-08-01T00:00:00Z",
            quota_snapshots: {
              chat: { entitlement: 400, remaining: 220, percent_remaining: 55 },
              completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100 },
            },
          },
        }
      },
    })

    expect(result.matchedOrg).toBeUndefined()
    expect(result.snapshot.windows).toMatchObject([
      { id: "chat", used: 45, remaining: 220, limit: 400 },
      { id: "completions", used: 0, remaining: 2000, limit: 2000 },
    ])
  })
})
