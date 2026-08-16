import type { ProviderUsageListOutput } from "@ycoding-ai/client"

export type ProviderUsageSnapshot = ProviderUsageListOutput["data"][number]
export type ProviderUsageWindow = ProviderUsageSnapshot["windows"][number]
export type UsageSeverity = "normal" | "warning" | "error"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const absoluteReset = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

export function progressBar(percent: number | undefined, cells = 10) {
  if (percent === undefined || !Number.isFinite(percent)) return undefined
  const normalized = Math.min(100, Math.max(0, percent))
  const filled = Math.min(cells, Math.max(0, Math.round((normalized / 100) * cells)))
  return `${"#".repeat(filled)}${"-".repeat(cells - filled)}`
}

export function usageSeverity(percent: number | undefined): UsageSeverity {
  if (percent === undefined || percent < 70) return "normal"
  if (percent < 90) return "warning"
  return "error"
}

export function formatReset(resetAt: number | undefined, now = Date.now()) {
  if (resetAt === undefined || !Number.isFinite(resetAt)) return undefined
  const remaining = resetAt - now
  if (remaining <= 0) return "reset due"
  if (remaining <= 6 * 60 * 60 * 1_000) {
    const minutes = Math.ceil(remaining / 60_000)
    const hours = Math.floor(minutes / 60)
    const tail = minutes % 60
    if (hours === 0) return `resets in ${minutes}m`
    return `resets in ${hours}h${tail ? ` ${tail}m` : ""}`
  }
  return `resets ${absoluteReset.format(new Date(resetAt))}`
}

export function formatWindowValue(window: ProviderUsageWindow) {
  if (window.unlimited) return "Unlimited"
  if (window.unit === "percent") return window.used === undefined ? "Not reported" : `${round(window.used)}% used`
  if (window.unit === "usd") {
    if (window.remaining !== undefined) return `${money.format(window.remaining)} left`
    if (window.used !== undefined && window.limit !== undefined)
      return `${money.format(window.used)} / ${money.format(window.limit)}`
    if (window.used !== undefined) return `${money.format(window.used)} used`
    return "Not reported"
  }
  if (window.remaining !== undefined) return `${formatNumber(window.remaining)} remaining`
  if (window.used !== undefined && window.limit !== undefined)
    return `${formatNumber(window.used)} / ${formatNumber(window.limit)} ${window.unit}`
  if (window.used !== undefined) return `${formatNumber(window.used)} ${window.unit}`
  return "Not reported"
}

export interface CompactUsageRow {
  readonly providerID: string
  readonly label: string
  readonly summary: string
  readonly status: ProviderUsageSnapshot["status"]
}

export function compactRows(snapshots: ReadonlyArray<ProviderUsageSnapshot>, activeProvider?: string): CompactUsageRow[] {
  return sortedSnapshots(snapshots, activeProvider).flatMap((snapshot) => {
    const spark = snapshot.windows.filter(isSpark)
    const main = snapshot.windows.filter((window) => !isSpark(window))
    const rows: CompactUsageRow[] = [
      {
        providerID: snapshot.providerID,
        label: snapshot.label,
        summary: compactSummary(main, snapshot.message),
        status: snapshot.status,
      },
    ]
    if (spark.length)
      rows.push({
        providerID: snapshot.providerID,
        label: "Spark",
        summary: compactSummary(spark),
        status: snapshot.status,
      })
    return rows
  })
}

export function sortedSnapshots(snapshots: ReadonlyArray<ProviderUsageSnapshot>, activeProvider?: string) {
  return [...snapshots].toSorted((left, right) => {
    const leftActive = left.providerID === activeProvider ? 0 : 1
    const rightActive = right.providerID === activeProvider ? 0 : 1
    return leftActive - rightActive || left.label.localeCompare(right.label)
  })
}

export function freshnessLabel(snapshot: ProviderUsageSnapshot, now = Date.now()) {
  if (snapshot.status === "stale") return "stale"
  if (snapshot.status !== "available") return snapshot.status
  if (snapshot.source === "response_headers") return "live"
  const age = Math.max(0, now - snapshot.updatedAt)
  if (age < 60_000) return "updated now"
  return `updated ${Math.floor(age / 60_000)}m`
}

export function stabilityLabel(snapshot: ProviderUsageSnapshot) {
  if (snapshot.stability === "best_effort") return "best effort"
  if (snapshot.stability === "client_contract") return "app-server"
  return undefined
}

function compactSummary(windows: ReadonlyArray<ProviderUsageWindow>, fallback?: string) {
  const items: string[] = []
  for (const window of windows) {
    if (window.unit === "percent" && window.used !== undefined) {
      const prefix = /secondary|weekly|seven-day|7d/i.test(`${window.id} ${window.label}`) ? "7d" : "5h"
      if (!items.some((item) => item.startsWith(`${prefix} `))) items.push(`${prefix} ${round(window.used)}%`)
      continue
    }
    if (window.unit === "usd" && (window.remaining !== undefined || window.unlimited)) {
      items.push(window.unlimited ? "Unlimited" : `${money.format(window.remaining!)} left`)
    }
  }
  return items.join(" · ") || fallback || "Not reported"
}

function isSpark(window: ProviderUsageWindow) {
  return /spark/i.test(`${window.id} ${window.label}`)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
