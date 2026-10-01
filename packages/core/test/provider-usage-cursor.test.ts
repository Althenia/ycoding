import { describe, expect, test } from "bun:test"
import { CursorUsage } from "@ycoding-ai/core/provider-usage/cursor"
import { ProviderV2 } from "@ycoding-ai/core/provider"

const input = { providerID: ProviderV2.ID.make("cursor"), label: "Cursor", updatedAt: 100 }

const usage = {
  billingCycleStart: "1790828591000",
  billingCycleEnd: "1793506991000",
  planUsage: { remaining: 1500, limit: 2000, remainingBonus: false, autoPercentUsed: 10, apiPercentUsed: 5, totalPercentUsed: 25 },
  enabled: true,
}

describe("CursorUsage", () => {
  test("maps plan usage to included, auto, and api windows", () => {
    const snapshot = CursorUsage.normalize({ ...input, usage })
    expect(snapshot).toMatchObject({
      label: "Cursor", status: "available", source: "provider_internal_api", stability: "best_effort",
      windows: [
        { id: "included", unit: "percent", used: 25, resetAt: 1793506991000, periodSeconds: 2678400 },
        { id: "auto", unit: "percent", used: 10 },
        { id: "api", unit: "percent", used: 5 },
      ],
    })
    // Plan allowance units are not percentages, so no percent meter may carry them.
    for (const window of snapshot.windows) {
      expect(window.limit).toBeUndefined()
      expect(window.remaining).toBeUndefined()
    }
  })

  test("labels with the plan name", () => {
    expect(CursorUsage.normalize({ ...input, usage, plan: { planInfo: { planName: "Pro" } } }).label).toBe("Cursor Pro")
    expect(CursorUsage.normalize({ ...input, usage, plan: { planInfo: { planName: " " } } }).label).toBe("Cursor")
    expect(CursorUsage.normalize({ ...input, usage, plan: "garbage" }).label).toBe("Cursor")
  })

  test("omits unknown values instead of reporting zero", () => {
    const snapshot = CursorUsage.normalize({ ...input, usage: { planUsage: { totalPercentUsed: 40, autoPercentUsed: "x" } } })
    expect(snapshot.windows).toHaveLength(1)
    expect(snapshot.windows[0]).toMatchObject({ id: "included", used: 40 })
    expect(snapshot.windows[0]?.limit).toBeUndefined()
    expect(snapshot.windows[0]?.resetAt).toBeUndefined()
    expect(snapshot.windows[0]?.periodSeconds).toBeUndefined()
  })

  test("rejects a payload without planUsage", () => {
    expect(() => CursorUsage.normalize({ ...input, usage: { enabled: true } })).toThrow("Invalid Cursor usage response")
    expect(() => CursorUsage.normalize({ ...input, usage: null })).toThrow()
  })
})
