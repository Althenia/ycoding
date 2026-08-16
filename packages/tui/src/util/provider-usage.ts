import type { ProviderUsageListOutput } from "@ycoding-ai/client"

export type ProviderUsageSnapshot = ProviderUsageListOutput["data"][number]
export type ProviderUsageWindow = ProviderUsageSnapshot["windows"][number]
export type UsageSeverity = "normal" | "warning" | "error"

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
const absoluteDate = new Intl.DateTimeFormat("en-US", {
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
  return `${"█".repeat(filled)}${"░".repeat(cells - filled)}`
}

export function contextCompositionBar(inputTokens: number, retainedTokens: number, cells = 24) {
  if (inputTokens <= 0) return { retained: "", removed: "" }
  const retained = Math.min(cells, Math.max(0, Math.round((retainedTokens / inputTokens) * cells)))
  return { retained: "▓".repeat(retained), removed: "█".repeat(cells - retained) }
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
  if (remaining <= 6 * 60 * 60 * 1_000) return `resets in ${formatRemaining(remaining)}`
  return `resets ${absoluteDate.format(new Date(resetAt))}`
}

export function formatBillDue(dueAt: number | undefined, now = Date.now()) {
  if (dueAt === undefined || !Number.isFinite(dueAt)) return undefined
  const remaining = dueAt - now
  if (remaining <= 0) return "bill due"
  if (remaining <= 6 * 60 * 60 * 1_000) return `bill due in ${formatRemaining(remaining)}`
  return `bill due ${absoluteDate.format(new Date(dueAt))}`
}

export function formatWindowValue(window: ProviderUsageWindow) {
  if (window.unlimited) return "Unlimited"
  if (window.unit === "percent") return window.used === undefined ? "Not reported" : `${round(window.used)}% used`
  if (window.unit === "usd") {
    if (window.used !== undefined && window.limit !== undefined) {
      const limit = `${money.format(window.used)} / ${money.format(window.limit)}`
      return window.remaining === undefined ? limit : `${limit} (${money.format(window.remaining)} left)`
    }
    if (window.remaining !== undefined) return `${money.format(window.remaining)} left`
    if (window.used !== undefined) return `${money.format(window.used)} used`
    return "Not reported"
  }
  if (window.remaining !== undefined) return `${formatNumber(window.remaining)} remaining`
  if (window.used !== undefined && window.limit !== undefined)
    return `${formatNumber(window.used)} / ${formatNumber(window.limit)} ${window.unit}`
  if (window.used !== undefined) return `${formatNumber(window.used)} ${window.unit}`
  return "Not reported"
}

export function freshnessLabel(snapshot: ProviderUsageSnapshot, now = Date.now()) {
  if (snapshot.status === "stale") return "stale"
  if (snapshot.status !== "available") return snapshot.status
  if (snapshot.source === "response_headers") return "live"
  const age = Math.max(0, now - snapshot.updatedAt)
  if (age < 60_000) return "updated now"
  return `updated ${Math.floor(age / 60_000)}m`
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function formatRemaining(remaining: number) {
  const minutes = Math.ceil(remaining / 60_000)
  const hours = Math.floor(minutes / 60)
  const tail = minutes % 60
  if (hours === 0) return `${minutes}m`
  return `${hours}h${tail ? ` ${tail}m` : ""}`
}
