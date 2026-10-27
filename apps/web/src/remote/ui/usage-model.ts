import type { RemoteUsageForecast, RemoteUsageProvider, RemoteUsageReportInput, RemoteUsageReportValue, RemoteUsageSummaryValue, RemoteUsageTokens } from "@ycoding-ai/remote"
import type { ModelRefView } from "../projection"
import { costText, type CostPresentation } from "./usage-accounting"
import type { UsageFiltersPresentation, UsageGroupPresentation } from "./usage-filter-model"

export type UsageProvider = RemoteUsageProvider
export type UsageWindow = RemoteUsageProvider["windows"][number]
export type UsageTokens = RemoteUsageTokens
export type UsageSummary = RemoteUsageSummaryValue["data"]
export type UsageReport = RemoteUsageReportValue["data"]
export type UsageReportRow = UsageReport["rows"][number]
export type UsageReportInput = RemoteUsageReportInput

export function matchingQuotaForecast(provider: UsageProvider, window: UsageWindow, forecasts: RemoteUsageForecast["quotas"] | undefined) {
  return forecasts?.find((quota) => quota.providerID === provider.providerID && quota.profile === provider.profile && quota.windowID === window.id && quota.unit === window.unit && quota.updatedAt === provider.updatedAt)
}

const legacyReportGroups: readonly UsageReportInput["group"][] = ["model", "hour", "day", "month", "session", "project", "agent"]

/** Older connectors reject these report groups, filters, and time zones with `invalid_message`. */
export const reportNeedsNewerConnector = (input: UsageReportInput) => !legacyReportGroups.includes(input.group) || input.timeZone !== undefined ||
  input.providerID !== undefined || input.profile !== undefined || input.modelID !== undefined || input.selectedEffort !== undefined

export function unsupportedReportMessage(input: UsageReportInput) {
  if (!legacyReportGroups.includes(input.group) || input.providerID !== undefined || input.profile !== undefined || input.modelID !== undefined || input.selectedEffort !== undefined)
    return "Update YCoding on this machine to use this grouping or filter."
  return input.timeZone !== undefined ? "Update YCoding on this machine to see Local usage. Switch to UTC to continue." : "Update YCoding on this machine to see usage."
}

export const reportKey = (input: UsageReportInput) => JSON.stringify({ group: input.group, providerID: input.providerID, profile: input.profile, modelID: input.modelID, selectedEffort: input.selectedEffort, timeZone: input.timeZone, from: input.from, to: input.to, offset: input.offset, limit: input.limit, sort: input.sort, order: input.order })

const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)
export const money = (value: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value)
export function compactUsageTotal(value: number, metric: "spend" | "tokens") {
  if (Math.abs(value) < 1_000) return metric === "spend" ? money(value) : new Intl.NumberFormat().format(value)
  const suffixes = ["k", "m", "b"]
  let magnitude = Math.min(Math.floor(Math.log10(Math.abs(value)) / 3), suffixes.length)
  let scaled = value / 1_000 ** magnitude
  if (Math.abs(Math.round(scaled * 10) / 10) >= 1_000 && magnitude < suffixes.length) {
    magnitude += 1
    scaled = value / 1_000 ** magnitude
  }
  const formatted = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(scaled)
  return metric === "spend" ? `$${formatted}${suffixes[magnitude - 1]}` : `${formatted}${suffixes[magnitude - 1]}`
}
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

export function modelIdentity(key: string, providers: readonly Pick<UsageProvider, "providerID" | "label">[], model?: ModelRefView) {
  if (model) return { providerID: model.providerID,
    provider: providerHeading(providers.find((item) => item.providerID === model.providerID) ?? { label: model.providerID }).name,
    model: `${model.id}${model.variant ? ` · selected effort ${model.variant}` : ""}${model.profile ? ` · profile ${model.profile}` : ""}` }
  const parts = key.split("/")
  if (parts.length < 2 || parts.length > 4) return undefined
  const providerID = new URLSearchParams(`id=${parts[0]}`).get("id")
  const modelID = new URLSearchParams(`id=${parts[1]}`).get("id")
  if (!providerID || !modelID) return undefined
  const variant = parts[2] ? new URLSearchParams(`id=${parts[2]}`).get("id") : undefined
  const profile = parts[3] ? new URLSearchParams(`id=${parts[3]}`).get("id") : undefined
  return { providerID, provider: providerHeading(providers.find((item) => item.providerID === providerID) ?? { label: providerID }).name,
    model: `${modelID}${variant ? ` · selected effort ${variant}` : ""}${profile ? ` · profile ${profile}` : ""}` }
}

export function reportLabel(row: Pick<UsageReportRow, "key" | "label">, group: UsageReportInput["group"]) {
  return group === "session" && (!row.label.trim() || row.label === row.key) ? `Session ${row.key} · title unreported` : row.label
}

export const visibleProviders = (providers: readonly UsageProvider[]) => providers.filter((provider) =>
  provider.status === "unsupported"
    ? provider.source === "response_stream" && provider.stability === "observed" && Boolean(provider.message?.trim())
    : provider.status === "unauthorized" || provider.windows.length > 0 || provider.status === "error" && Boolean(provider.message?.trim()))

export type DistributionSegment = { readonly providerID: string; readonly label: string; readonly value: number; readonly share: number; readonly costLabel?: string }

export function providerDistribution(report: UsageReport | undefined, providers: readonly Pick<UsageProvider, "providerID" | "label">[], metric: "spend" | "tokens") {
  if (report === undefined) return { total: 0, segments: [] as DistributionSegment[] }
  const amount = (row: UsageReportRow) => metric === "spend" ? row.cost ?? 0 : tokenCount(row.tokens)
  const grouped = new Map<string, { value: number; cost?: number; costCoverage?: UsageReportRow["costCoverage"] }>()
  const add = (providerID: string, value: number, price: Pick<UsageReportRow, "cost" | "costCoverage">) => {
    const current = grouped.get(providerID)
    grouped.set(providerID, {
      value: (current?.value ?? 0) + value,
      cost: current?.cost === undefined && price.cost === undefined ? undefined : (current?.cost ?? 0) + (price.cost ?? 0),
      costCoverage: current === undefined ? price.costCoverage : current.costCoverage && price.costCoverage ? {
        pricedRequests: current.costCoverage.pricedRequests + price.costCoverage.pricedRequests,
        unpricedRequests: current.costCoverage.unpricedRequests + price.costCoverage.unpricedRequests,
      } : undefined,
    })
  }
  report.rows.forEach((row) => {
    const providerID = modelIdentity(row.key, providers, row.model)?.providerID ?? "other"
    add(providerID, amount(row), row)
  })
  const listed = report.rows.reduce((sum, row) => sum + amount(row), 0)
  const remainder = report.nextOffset === undefined ? 0 : Math.max(0, (metric === "spend" ? report.total.cost ?? 0 : tokenCount(report.total.tokens)) - listed)
  if (report.nextOffset !== undefined) {
    const costCoverage = report.total.costCoverage && report.rows.every((row) => row.costCoverage !== undefined) ? {
      pricedRequests: Math.max(0, report.total.costCoverage.pricedRequests - report.rows.reduce((sum, row) => sum + row.costCoverage!.pricedRequests, 0)),
      unpricedRequests: Math.max(0, report.total.costCoverage.unpricedRequests - report.rows.reduce((sum, row) => sum + row.costCoverage!.unpricedRequests, 0)),
    } : undefined
    const cost = report.total.cost === undefined ? undefined : Math.max(0, report.total.cost - report.rows.reduce((sum, row) => sum + (row.cost ?? 0), 0))
    add("other", remainder, { costCoverage, cost: (costCoverage?.pricedRequests ?? 0) > 0 || cost !== undefined && cost > 0.000001 ? cost : undefined })
  }
  const total = [...grouped.values()].reduce((sum, value) => sum + value.value, 0)
  return { total, segments: [...grouped].filter(([, value]) => value.value > 0).map(([providerID, value]) => ({
    providerID, label: providerID === "other" ? "Other" : providerHeading(providers.find((provider) => provider.providerID === providerID) ?? { label: providerID }).name,
    value: value.value, share: value.value / total, costLabel: reportCostText(value),
  })) }
}

export function donutGeometry(segments: readonly DistributionSegment[], radius: number) {
  const circumference = 2 * Math.PI * radius
  return segments.map((segment, index) => ({ ...segment, length: circumference * segment.share,
    offset: -circumference * segments.slice(0, index).reduce((sum, previous) => sum + previous.share, 0), circumference }))
}

export function quotaGroupHeading(windows: readonly Pick<UsageWindow, "group">[], index: number) {
  const group = windows[index]?.group
  return group !== undefined && group !== windows[index - 1]?.group ? group : undefined
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
  const exhausted = window.unlimited !== true && ((fill !== undefined && fill >= 100) || window.remaining === 0)
  return { used, limit, remaining, fill, pace, reset, exhausted }
}

export type Spend = { readonly cost: number; readonly tokens: number; readonly requests: number; readonly provenance?: "estimate"; readonly costReported?: boolean; readonly costCoverage?: { readonly pricedRequests: number; readonly unpricedRequests: number } }
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

export function usageBounds(now: number, timeZone?: string, days = 30) {
  const formatter = timeZone === undefined ? undefined : new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  const date = formatter ? localDate(now, formatter) : { year: new Date(now).getUTCFullYear(), month: new Date(now).getUTCMonth() + 1, day: new Date(now).getUTCDate() }
  const today = Date.UTC(date.year, date.month - 1, date.day)
  const start = new Date(today - (days - 1) * 86_400_000)
  const tomorrow = new Date(today + 86_400_000)
  return {
    from: formatter ? localMidnight(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), formatter) : start.getTime(),
    to: formatter ? localMidnight(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), formatter) : tomorrow.getTime(),
    monthFrom: formatter ? localMidnight(date.year, date.month, 1, formatter) : Date.UTC(date.year, date.month - 1, 1),
  }
}

export const usageZoneKey = "ycoding.remote.usage.timeZone"

export type UsageBreakdown = Pick<UsageReportInput, "offset" | "sort" | "order" | "providerID" | "profile" | "modelID" | "selectedEffort" | "from" | "to"> & { readonly group: UsageGroupPresentation; readonly range?: UsageFiltersPresentation["range"] }

/** The report reads the Usage page opens with; the day boundary, not the clock, keys them so a revisit or preload reuses the same reads. */
export function usageReportInputs(now: number, timeZone: string | undefined, breakdown: UsageBreakdown = { group: "model", offset: 0, sort: "cost", order: "desc" }) {
  const bounds = usageBounds(now, timeZone)
  const zone = timeZone === undefined ? {} : { timeZone }
  const range = { from: bounds.from, to: bounds.to, ...zone }
  return {
    daily: { group: "day", ...range, limit: 30, sort: "key", order: "asc" } satisfies UsageReportInput,
    monthly: { group: "model", from: bounds.monthFrom, to: bounds.to, ...zone, limit: 200, sort: "cost", order: "desc" } satisfies UsageReportInput,
    breakdown: { group: breakdown.group, ...(breakdown.range === "all" ? zone : breakdown.range === "custom" ? { ...zone, from: breakdown.from, to: breakdown.to } : { ...range, ...(breakdown.range === "last7" ? { from: usageBounds(now, timeZone, 7).from } : {}) }),
      ...(breakdown.providerID ? { providerID: breakdown.providerID } : {}), ...(breakdown.profile ? { profile: breakdown.profile } : {}), ...(breakdown.modelID ? { modelID: breakdown.modelID } : {}), ...(breakdown.selectedEffort ? { selectedEffort: breakdown.selectedEffort } : {}),
      offset: breakdown.offset, limit: 25, sort: breakdown.sort, order: breakdown.order } satisfies UsageReportInput & UsageBreakdown,
  }
}

export function reportCost(value: Pick<UsageReportRow, "cost" | "costCoverage" | "costProvenance">): CostPresentation | undefined {
  if (!value.costCoverage) return undefined
  return { ...value.costCoverage, known: value.cost, provenance: value.costProvenance,
    ...(value.costCoverage.unpricedRequests === 0 && value.cost !== undefined ? { total: value.cost } : {}) }
}

export function reportCostText(value: Pick<UsageReportRow, "cost" | "costCoverage" | "costProvenance">) {
  return value.costCoverage === undefined && value.cost !== undefined ? `Known ${money(value.cost)} · coverage unreported` : costText(reportCost(value))
}

export function reportIdentity(row: UsageReportRow, providers: readonly Pick<UsageProvider, "providerID" | "label">[]) {
  if (row.dimensions === undefined) return modelIdentity(row.key, providers, row.model)
  const dimension = row.dimensions
  if (dimension.group === "prompt") return { providerID: "", provider: dimension.attribution, model: dimension.anchor ? `${dimension.anchor.sessionID} · ${dimension.anchor.inputID}` : "Unattributed" }
  if (dimension.group === "task") return { providerID: "", provider: `${dimension.attribution} · inclusive`, model: dimension.sessionID ?? "Unattributed" }
  const providerID = "providerID" in dimension ? dimension.providerID : ""
  const provider = providers.find((item) => item.providerID === providerID)?.label ?? providerID
  return { providerID, provider, model: ["modelID" in dimension ? dimension.modelID : undefined,
    "profileState" in dimension ? dimension.profileState === "provider-default" ? "provider default at request time" : `profile ${dimension.profile}` : undefined].filter(Boolean).join(" · ") || provider }
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
      costReported: row?.cost !== undefined,
      costCoverage: row === undefined ? { pricedRequests: 0, unpricedRequests: 0 } : row.costCoverage,
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
    costReported: days.some((day) => day.requests > 0 && day.costReported !== false),
    costCoverage: days.every((day) => day.costCoverage !== undefined) ? { pricedRequests: days.reduce((sum, day) => sum + day.costCoverage!.pricedRequests, 0), unpricedRequests: days.reduce((sum, day) => sum + day.costCoverage!.unpricedRequests, 0) } : undefined,
  }
}

export function spendCostText(value: Spend) {
  if (value.requests === 0) return "No retained requests"
  if (value.costReported === false) return "unreported"
  return reportCostText({ cost: value.cost, costCoverage: value.costCoverage })
}
