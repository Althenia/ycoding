import { expect, test } from "bun:test"
import { dailySpend, quotaWindow, reportKey, spendMetrics } from "./usage-model"

const tokens = { input: 900, output: 100, reasoning: 20, cache: { read: 300, write: 40 } }
const row = (label: string, cost?: number, costProvenance?: "recorded" | "current_catalog") => ({
  key: label, label, logical: 2, physical: 3, helpers: 0, continued: 0, fallback: 0, tokens, cost, costProvenance,
})

test("quota omits unknown values and calculates pace against the elapsed period", () => {
  const now = Date.UTC(2026, 8, 27, 12)
  expect(quotaWindow({ id: "week", label: "Weekly", unit: "percent", used: 30, limit: 100, resetAt: now + 3 * 86_400_000, periodSeconds: 7 * 86_400 }, now)).toMatchObject({
    used: "30%", remaining: undefined, fill: 30, pace: "Below pace", reset: "Resets in 3 days",
  })
  expect(quotaWindow({ id: "balance", label: "Balance", unit: "usd", remaining: 12.5 }, now)).toMatchObject({
    used: undefined, remaining: "$12.50", fill: undefined, reset: undefined, pace: undefined,
  })
  expect(quotaWindow({ id: "session", label: "Session", unit: "percent", used: 38, resetAt: now + 2 * 3600_000, periodSeconds: 5 * 3600 }, now)).toMatchObject({
    used: "38%", limit: undefined, fill: 38, pace: "Below pace",
  })
  expect(quotaWindow({ id: "none", label: "Unknown", unit: "count" }, now).used).toBeUndefined()
})

test("daily spend uses UTC days, all token buckets, zeroes unknown cost, and labels only catalog estimates", () => {
  const now = Date.UTC(2026, 8, 27, 14)
  const report = { group: "day" as const, rows: [row("2026-09-26", 3, "recorded"), row("2026-09-27", 5, "current_catalog")], total: row("total"), rowCount: 2 }
  const days = dailySpend(report, now)
  expect(days).toHaveLength(30)
  expect(days.at(-1)).toMatchObject({ label: "Today", cost: 5, provenance: "estimate", requests: 3 })
  expect(days.at(-2)).toMatchObject({ label: "Yesterday", cost: 3, provenance: undefined })
  expect(spendMetrics(days)).toMatchObject({ cost: 8, requests: 6, tokens: 2720, provenance: "estimate" })
  expect(reportKey({ group: "model", limit: 25, sort: "cost", order: "desc" })).toBe(reportKey({ order: "desc", sort: "cost", limit: 25, group: "model" }))
})
