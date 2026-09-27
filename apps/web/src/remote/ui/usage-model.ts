import type { RemoteUsageProvider, RemoteUsageReportInput, RemoteUsageReportValue, RemoteUsageSummaryValue, RemoteUsageTokens } from "@ycoding-ai/remote"

export type UsageProvider = RemoteUsageProvider
export type UsageWindow = RemoteUsageProvider["windows"][number]
export type UsageTokens = RemoteUsageTokens
export type UsageSummary = RemoteUsageSummaryValue["data"]
export type UsageReport = RemoteUsageReportValue["data"]
export type UsageReportRow = UsageReport["rows"][number]
export type UsageReportInput = RemoteUsageReportInput

export const reportKey = (input: UsageReportInput) => JSON.stringify({ group: input.group, from: input.from, to: input.to, offset: input.offset, limit: input.limit, sort: input.sort, order: input.order })

const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
export const money = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value)
export const tokenCount = (value: UsageTokens) => value.input + value.output + value.reasoning + value.cache.read + value.cache.write

export function quotaWindow(window: UsageWindow, now: number) {
  const format = (value: number) => window.unit === "usd" ? money(value) : `${number(value)}${window.unit === "percent" ? "%" : ""}`
  const used = window.used === undefined ? undefined : format(window.used)
  const limit = window.limit === undefined ? undefined : format(window.limit)
  const remaining = window.remaining === undefined ? undefined : format(window.remaining)
  const fill = window.unit === "percent" && window.used !== undefined
    ? Math.max(0, Math.min(100, window.used))
    : window.limit !== undefined && window.limit > 0 && window.used !== undefined
      ? Math.max(0, Math.min(100, window.used / window.limit * 100)) : undefined
  const elapsed = window.resetAt !== undefined && window.periodSeconds !== undefined && window.periodSeconds > 0
    ? 1 - (window.resetAt - now) / (window.periodSeconds * 1000) : undefined
  const pace = fill !== undefined && elapsed !== undefined && elapsed > 0 && elapsed < 1
    ? fill > elapsed * 100 + 3 ? "Ahead of pace" : fill < elapsed * 100 - 3 ? "Below pace" : "On pace" : undefined
  const seconds = window.resetAt === undefined ? undefined : Math.max(0, Math.ceil((window.resetAt - now) / 1000))
  const reset = seconds === undefined ? undefined : seconds === 0 ? "Reset due" : seconds >= 86_400
    ? `Resets in ${Math.ceil(seconds / 86_400)} ${Math.ceil(seconds / 86_400) === 1 ? "day" : "days"}`
    : seconds >= 3600 ? `Resets in ${Math.ceil(seconds / 3600)} ${Math.ceil(seconds / 3600) === 1 ? "hour" : "hours"}`
    : `Resets in ${Math.ceil(seconds / 60)} ${Math.ceil(seconds / 60) === 1 ? "minute" : "minutes"}`
  return { used, limit, remaining, fill, pace, reset }
}

export type Spend = { readonly cost: number; readonly tokens: number; readonly requests: number; readonly provenance?: "estimate" }
export type SpendDay = Spend & { readonly key: string; readonly label: string }

export function dailySpend(report: UsageReport | undefined, now: number): SpendDay[] {
  const today = Math.floor(now / 86_400_000) * 86_400_000
  const rows = new Map(report?.rows.map((row) => [row.key, row]) ?? [])
  return Array.from({ length: 30 }, (_, index) => {
    const key = new Date(today - (29 - index) * 86_400_000).toISOString().slice(0, 10)
    const row = rows.get(key)
    return {
      key, label: index === 29 ? "Today" : index === 28 ? "Yesterday" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${key}T00:00:00Z`)),
      cost: row?.cost ?? 0, tokens: row ? tokenCount(row.tokens) : 0, requests: row?.physical ?? 0,
      provenance: row?.costProvenance === "current_catalog" ? "estimate" as const : undefined,
    }
  })
}

export function spendMetrics(days: readonly Spend[]): Spend {
  return {
    cost: days.reduce((sum, day) => sum + day.cost, 0),
    tokens: days.reduce((sum, day) => sum + day.tokens, 0),
    requests: days.reduce((sum, day) => sum + day.requests, 0),
    provenance: days.some((day) => day.provenance === "estimate") ? "estimate" : undefined,
  }
}
