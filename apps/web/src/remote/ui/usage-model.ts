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

export function providerHeading(provider: Pick<UsageProvider, "label" | "profile">) {
  if (provider.profile) return { name: provider.label, plan: provider.profile }
  const separator = provider.label.indexOf(" · ")
  return separator < 0 ? { name: provider.label, plan: undefined } : {
    name: provider.label.slice(0, separator), plan: provider.label.slice(separator + 3),
  }
}

export function relativeFreshness(updatedAt: number, now: number) {
  const elapsed = Math.max(0, now - updatedAt)
  if (elapsed < 60_000) return "just now"
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  return `${Math.floor(elapsed / 86_400_000)}d ago`
}

export function modelIdentity(key: string, providers: readonly Pick<UsageProvider, "providerID" | "label">[]) {
  const parts = key.split("/")
  if (parts.length < 2 || parts.length > 3) return undefined
  const providerID = new URLSearchParams(`id=${parts[0]}`).get("id")
  const modelID = new URLSearchParams(`id=${parts[1]}`).get("id")
  if (!providerID || !modelID) return undefined
  const variant = parts[2] ? new URLSearchParams(`id=${parts[2]}`).get("id") : undefined
  return { providerID, provider: providerHeading(providers.find((item) => item.providerID === providerID) ?? { label: providerID }).name,
    model: `${modelID}${variant ? ` · ${variant}` : ""}` }
}

export const visibleProviders = (providers: readonly UsageProvider[]) => providers.filter((provider) =>
  provider.status !== "unsupported" && provider.status !== "unauthorized" &&
  (provider.windows.length > 0 || provider.status === "error" && Boolean(provider.message?.trim())))

export type DistributionSegment = { readonly providerID: string; readonly label: string; readonly value: number; readonly share: number }

export function providerDistribution(report: UsageReport | undefined, providers: readonly Pick<UsageProvider, "providerID" | "label">[], metric: "spend" | "tokens") {
  if (report === undefined) return { total: 0, segments: [] as DistributionSegment[] }
  const amount = (row: UsageReportRow) => metric === "spend" ? row.cost ?? 0 : tokenCount(row.tokens)
  const grouped = report.rows.reduce((totals, row) => {
    const providerID = modelIdentity(row.key, providers)?.providerID ?? "other"
    totals.set(providerID, (totals.get(providerID) ?? 0) + amount(row))
    return totals
  }, new Map<string, number>())
  const listed = report.rows.reduce((sum, row) => sum + amount(row), 0)
  const remainder = report.nextOffset === undefined ? 0 : Math.max(0, (metric === "spend" ? report.total.cost ?? 0 : tokenCount(report.total.tokens)) - listed)
  if (remainder > 0.000001) grouped.set("other", (grouped.get("other") ?? 0) + remainder)
  const total = [...grouped.values()].reduce((sum, value) => sum + value, 0)
  return { total, segments: [...grouped].filter(([, value]) => value > 0).map(([providerID, value]) => ({
    providerID, label: providerID === "other" ? "Other" : providerHeading(providers.find((provider) => provider.providerID === providerID) ?? { label: providerID }).name,
    value, share: value / total,
  })) }
}

export function donutGeometry(segments: readonly DistributionSegment[], radius: number) {
  const circumference = 2 * Math.PI * radius
  return segments.map((segment, index) => ({ ...segment, length: circumference * segment.share,
    offset: -circumference * segments.slice(0, index).reduce((sum, previous) => sum + previous.share, 0), circumference }))
}

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
