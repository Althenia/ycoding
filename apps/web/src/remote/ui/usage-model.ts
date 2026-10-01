import type { RemoteUsageProvider, RemoteUsageReportInput, RemoteUsageReportValue, RemoteUsageSummaryValue, RemoteUsageTokens } from "@ycoding-ai/remote"

export type UsageProvider = RemoteUsageProvider
export type UsageWindow = RemoteUsageProvider["windows"][number]
export type UsageTokens = RemoteUsageTokens
export type UsageSummary = RemoteUsageSummaryValue["data"]
export type UsageReport = RemoteUsageReportValue["data"]
export type UsageReportRow = UsageReport["rows"][number]
export type UsageReportInput = RemoteUsageReportInput

export const reportKey = (input: UsageReportInput) => JSON.stringify({ group: input.group, timeZone: input.timeZone, from: input.from, to: input.to, offset: input.offset, limit: input.limit, sort: input.sort, order: input.order })

const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
export const money = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value)
export const tokenCount = (value: UsageTokens) => value.input + value.output + value.reasoning + value.cache.read + value.cache.write

export function tooltipPosition(
  card: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  anchor: { readonly x: number; readonly y: number },
  tooltip: { readonly width: number; readonly height: number },
) {
  const left = Math.max(card.left + 8, 8)
  const top = Math.max(card.top + 8, 8)
  return {
    left: Math.min(Math.max(anchor.x + 12, left), Math.max(left, Math.min(card.left + card.width, viewport.width) - tooltip.width - 8)) - card.left,
    top: Math.min(Math.max(anchor.y + 12, top), Math.max(top, Math.min(card.top + card.height, viewport.height) - tooltip.height - 8)) - card.top,
  }
}

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

function localDate(time: number, formatter: Intl.DateTimeFormat) {
  const parts = formatter.formatToParts(time)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value)
  return { year: part("year"), month: part("month"), day: part("day") }
}

function localMidnight(year: number, month: number, day: number, formatter: Intl.DateTimeFormat) {
  const target = Date.UTC(year, month - 1, day)
  const start = target - 48 * 3_600_000
  const ordinal = (time: number) => {
    const date = localDate(time, formatter)
    return Date.UTC(date.year, date.month - 1, date.day)
  }
  for (let end = start + 3_600_000; end <= target + 48 * 3_600_000; end += 3_600_000) {
    if (ordinal(end - 3_600_000) >= target || ordinal(end) < target) continue
    let low = end - 3_600_000
    let high = end
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2)
      if (ordinal(middle) >= target) high = middle
      else low = middle
    }
    return high
  }
  throw new RangeError("Local calendar boundary is unavailable")
}

export function usageBounds(now: number, timeZone?: string) {
  const formatter = timeZone === undefined ? undefined : new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  const date = formatter ? localDate(now, formatter) : { year: new Date(now).getUTCFullYear(), month: new Date(now).getUTCMonth() + 1, day: new Date(now).getUTCDate() }
  const today = Date.UTC(date.year, date.month - 1, date.day)
  const start = new Date(today - 29 * 86_400_000)
  const tomorrow = new Date(today + 86_400_000)
  return {
    from: formatter ? localMidnight(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), formatter) : start.getTime(),
    to: formatter ? localMidnight(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), formatter) : tomorrow.getTime(),
    monthFrom: formatter ? localMidnight(date.year, date.month, 1, formatter) : Date.UTC(date.year, date.month - 1, 1),
  }
}

export const usageZoneKey = "ycoding.remote.usage.timeZone"

export type UsageBreakdown = Pick<UsageReportInput, "offset" | "sort" | "order"> & { readonly group: "model" | "session" | "project" | "agent" }

/** The report reads the Usage page opens with; the day boundary, not the clock, keys them so a revisit or preload reuses the same reads. */
export function usageReportInputs(now: number, timeZone: string | undefined, breakdown: UsageBreakdown = { group: "model", offset: 0, sort: "cost", order: "desc" }) {
  const bounds = usageBounds(now, timeZone)
  const zone = timeZone === undefined ? {} : { timeZone }
  const range = { from: bounds.from, to: bounds.to, ...zone }
  return {
    daily: { group: "day", ...range, limit: 30, sort: "key", order: "asc" } satisfies UsageReportInput,
    monthly: { group: "model", from: bounds.monthFrom, to: bounds.to, ...zone, limit: 200, sort: "cost", order: "desc" } satisfies UsageReportInput,
    breakdown: { group: breakdown.group, ...range, offset: breakdown.offset, limit: 25, sort: breakdown.sort, order: breakdown.order } satisfies UsageReportInput & UsageBreakdown,
  }
}

export function dailySpend(report: UsageReport | undefined, now: number, timeZone?: string): SpendDay[] {
  const date = timeZone === undefined ? undefined : localDate(now, new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }))
  const today = date === undefined ? Math.floor(now / 86_400_000) * 86_400_000 : Date.UTC(date.year, date.month - 1, date.day)
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
