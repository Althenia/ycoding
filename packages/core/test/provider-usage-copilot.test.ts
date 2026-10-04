import { describe, expect, test } from "bun:test"
import { CopilotUsage } from "@ycoding-ai/core/provider-usage/copilot"
import { Provider } from "@ycoding-ai/core/provider"

const providerID = Provider.ID.make("github-copilot")
const userStatusPath = "/copilot_internal/user"
const orgsPath = "/user/orgs"
const summaryPath = (org: string) => `/orgs/${org}/settings/billing/usage/summary`

describe("CopilotUsage", () => {
  test("presents paid AI credits and extra usage without legacy premium labels", () => {
    const snapshot = CopilotUsage.normalizeQuota({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        copilot_plan: "INDIVIDUAL",
        quota_reset_date: "2026-08-01T00:00:00Z",
        quota_snapshots: {
          chat: { entitlement: -1, remaining: -1, unlimited: true },
          completions: { entitlement: -1, remaining: -1, unlimited: true },
          premium_interactions: { entitlement: 1000000, remaining: 999999, percent_remaining: 99, overage_count: 7, overage_permitted: true, unlimited: false },
        },
      },
    })

    expect(snapshot).toMatchObject({
      label: "GitHub Copilot",
      status: "available",
      source: "provider_internal_api",
      stability: "best_effort",
      windows: [
        { id: "credits", label: "AI credits", unit: "percent", used: 1, resetAt: Date.parse("2026-08-01T00:00:00Z") },
        { id: "extra-usage", label: "Extra usage", unit: "count", used: 7 },
      ],
    })
    expect(JSON.stringify(snapshot)).not.toContain("Premium requests")
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

  test("omits unlimited chat and completions rather than inventing percentages", () => {
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

    expect(snapshot.windows).toEqual([])
  })

  test("does not invent zero extra usage when an enabled overage count is absent", () => {
    const snapshot = CopilotUsage.normalizeQuota({ providerID, label: "GitHub Copilot", updatedAt: 100,
      response: { quota_snapshots: { premium_interactions: {
        entitlement: 100, remaining: 80, overage_permitted: true,
      } } },
    })
    expect(snapshot.windows.map((window) => window.id)).toEqual(["credits"])
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
        { id: "chat", label: "Chat", unit: "percent", used: 0, resetAt: Date.parse("2026-08-01T00:00:00Z") },
        { id: "completions", label: "Completions", unit: "percent", used: 0 },
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

  test("keeps a reported zero AI-credit count on an org-managed seat", () => {
    const snapshot = CopilotUsage.normalizeQuota({ providerID, label: "GitHub Copilot", updatedAt: 100, response: {
      token_based_billing: true,
      quota_snapshots: { premium_interactions: { entitlement: 0, credits_used: 0 } },
    } })
    expect(snapshot.windows).toMatchObject([{ id: "credits", label: "AI credits", unit: "count", used: 0 }])
  })

  test("keeps personal AI credits for an org seat even when billing access is denied", async () => {
    const calls: string[] = []
    const result = await CopilotUsage.load({
      providerID, label: "GitHub Copilot", updatedAt: 100,
      request: async (path) => {
        calls.push(path)
        if (path === userStatusPath) return { status: 200, body: {
          copilot_plan: "BUSINESS", token_based_billing: true,
          quota_snapshots: { premium_interactions: { entitlement: 0, credits_used: 42.5, overage_permitted: true, overage_count: 0 } },
        } }
        return { status: 403, body: null }
      },
    })
    expect(calls).toEqual([userStatusPath, orgsPath])
    expect(result.snapshot.windows).toMatchObject([{ id: "credits", label: "AI credits", unit: "count", used: 42.5 }])
    expect(result.snapshot.windows.some((window) => window.id === "extra-usage")).toBe(false)
    expect(result.snapshot.status).toBe("available")
  })

  test("keeps personal AI credits when optional org discovery fails", async () => {
    const result = await CopilotUsage.load({
      providerID, label: "GitHub Copilot", updatedAt: 100,
      request: async (path) => path === userStatusPath
        ? { status: 200, body: { token_based_billing: true, quota_snapshots: {
          premium_interactions: { entitlement: 0, credits_used: 9 },
        } } }
        : Promise.reject(new Error("private network response")),
    })
    expect(result.snapshot.windows).toMatchObject([{ id: "credits", used: 9 }])
    expect(JSON.stringify(result)).not.toContain("private network response")
  })

  test("maps only organization Copilot credit billing to separate credits and billed spend", () => {
    const result = CopilotUsage.normalizeBilling({
      providerID, label: "GitHub Copilot", updatedAt: 100,
      response: { usageItems: [
        { product: "Actions", unitType: "ai-units", grossQuantity: 500, netAmount: 5 },
        { product: "Copilot", unitType: "seats", grossQuantity: 20, netAmount: 400 },
        { product: "Copilot", unitType: "ai-units", grossQuantity: 10.5, netAmount: 0 },
        { product: "Copilot", unitType: "ai-credits", grossQuantity: 3, netAmount: 0.03 },
      ] },
    })
    expect(result.snapshot.windows).toMatchObject([
      { id: "org-credits", label: "Org credits", unit: "count", used: 13.5 },
      { id: "org-spend", label: "Org spend", unit: "usd", used: 0.03 },
    ])
    expect(result.matched).toBe(true)
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
              token_based_billing: true,
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
                { product: "Copilot", unitType: "ai-units", grossQuantity: 1234, netAmount: 12.34 },
              ],
            },
          }
        return { status: 404, body: null }
      },
    })

    expect(calls).toEqual([userStatusPath, orgsPath, summaryPath("acme"), summaryPath("globex")])
    expect(result.matchedOrg).toBe("globex")
    expect(result.snapshot).toMatchObject({ source: "provider_api", stability: "stable" })
    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({
        id: "org-credits",
        label: "Org credits",
        unit: "count",
        used: 1234,
      }),
      expect.objectContaining({ id: "org-spend", label: "Org spend", unit: "usd", used: 12.34 }),
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
          return { status: 200, body: { token_based_billing: true } }
        if (path === summaryPath("globex"))
          return {
            status: 200,
            body: {
              usageItems: [
                { product: "Copilot", unitType: "ai-units", grossQuantity: 77, netAmount: 0.77 },
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
        if (path === userStatusPath) return { status: 200, body: { token_based_billing: true } }
        if (path === summaryPath("globex")) return { status: 404, body: null }
        if (path === orgsPath) return { status: 200, body: [{ login: "acme" }] }
        if (path === summaryPath("acme"))
          return {
            status: 200,
            body: {
              usageItems: [
                { product: "Copilot", unitType: "ai-units", grossQuantity: 5, netAmount: 0.05 },
              ],
            },
          }
        return { status: 404, body: null }
      },
    })

    expect(result.matchedOrg).toBe("acme")
    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({ id: "org-credits", used: 5 }),
      expect.objectContaining({ id: "org-spend", used: 0.05 }),
    ])
  })

  test("reports nothing when no org answers, leaving windows absent", async () => {
    const result = await CopilotUsage.load({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      request: async (path) => {
        if (path === userStatusPath) return { status: 200, body: { token_based_billing: true } }
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

  test("normalizes billed credits without a fabricated reset", () => {
    const result = CopilotUsage.normalizeBilling({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        usageItems: [
          { product: "Copilot", unitType: "ai-units", grossQuantity: 1234 },
        ],
      },
    })

    expect(result.matched).toBe(true)
    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({
        id: "org-credits",
        label: "Org credits",
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
        usageItems: [{ product: "Copilot", unitType: "ai-units", grossQuantity: 1234, netAmount: 12.34 }],
      },
    })

    expect(result.matched).toBe(true)
    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({ id: "org-credits", unit: "count", used: 1234 }),
      expect.objectContaining({ id: "org-spend", unit: "usd", used: 12.34 }),
    ])
  })

  test("reports only measured org spend when the credit quantity is absent", () => {
    const result = CopilotUsage.normalizeBilling({
      providerID,
      label: "GitHub Copilot",
      updatedAt: 100,
      response: {
        usageItems: [{ product: "Copilot", unitType: "ai-units", netAmount: 2.0 }],
      },
    })

    expect(result.snapshot.windows).toEqual([
      expect.objectContaining({ id: "org-spend", unit: "usd", used: 2 }),
    ])
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
    await CopilotUsage.load({
        providerID,
        label: "GitHub Copilot",
        updatedAt: 100,
        request: async () => ({ status: 429, body: { message: "limited" } }),
    }).then(
      () => { throw new Error("Expected provider status failure") },
      (error: unknown) => expect(error).toMatchObject({ _tag: "CopilotUsage.RequestError", status: 429 }),
    )
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
