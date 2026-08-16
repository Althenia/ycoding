export * as ClaudeUsage from "./claude"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderV2 } from "../provider"
import { Schema } from "effect"

export interface NormalizeHeadersInput {
  readonly providerID: ProviderV2.ID
  readonly label: string
  readonly subscriptionType?: string
  readonly observedAt: number
  readonly headers: Headers | Readonly<Record<string, string>>
}

export interface NormalizeOAuthInput {
  readonly providerID: ProviderV2.ID
  readonly label: string
  readonly subscriptionType?: string
  readonly updatedAt: number
  readonly response: unknown
}

export class RequestError extends Schema.TaggedErrorClass<RequestError>()("ClaudeUsage.RequestError", {
  status: Schema.Number,
  retryAfter: Schema.Number.pipe(Schema.optional),
}) {}

export interface LoadOAuthInput extends Omit<NormalizeOAuthInput, "response"> {
  readonly resolve: () => Promise<{ readonly accessToken: string; readonly subscriptionType?: string } | null>
  readonly refresh: () => Promise<{ readonly accessToken: string; readonly subscriptionType?: string } | null>
  readonly request: (accessToken: string) => Promise<{
    readonly status: number
    readonly retryAfter?: number
    readonly body: unknown
  }>
}

export async function loadOAuth(input: LoadOAuthInput) {
  const current = await input.resolve()
  if (!current) throw new RequestError({ status: 401 })
  let account = current
  let response = await input.request(current.accessToken)
  if (response.status === 401) {
    const refreshed = await input.refresh()
    if (refreshed && refreshed.accessToken !== current.accessToken) {
      account = refreshed
      response = await input.request(refreshed.accessToken)
    }
  }
  if (response.status < 200 || response.status >= 300)
    throw new RequestError({
      status: response.status,
      ...(response.retryAfter === undefined ? {} : { retryAfter: response.retryAfter }),
    })
  return normalizeOAuth({
    providerID: input.providerID,
    label: input.label,
    subscriptionType: account.subscriptionType ?? input.subscriptionType,
    updatedAt: input.updatedAt,
    response: response.body,
  })
}

export function normalizeHeaders(input: NormalizeHeadersInput) {
  const headers = input.headers instanceof Headers ? input.headers : new Headers(input.headers)
  const windows = [
    ...headerWindow(headers, "five-hour", "5-hour", "anthropic-ratelimit-unified-5h", "anthropic-ratelimit-unified-5h-reset"),
    ...headerWindow(headers, "seven-day", "Weekly", "anthropic-ratelimit-unified-7d", "anthropic-ratelimit-unified-7d-reset"),
    ...headerWindow(headers, "overage", "Extra usage", "anthropic-ratelimit-unified-overage"),
  ]
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: accountLabel(input.label, input.subscriptionType),
    status: "available",
    source: "response_headers",
    stability: "observed",
    updatedAt: Math.max(0, Math.trunc(input.observedAt)),
    windows,
  })
}

export function normalizeOAuth(input: NormalizeOAuthInput) {
  if (!record(input.response)) throw new Error("Invalid Claude usage response")
  const windows = Object.entries(input.response).flatMap(([key, value]) => {
    if (key === "extra_usage") return extraUsage(value)
    if (key !== "five_hour" && key !== "seven_day" && !key.startsWith("seven_day_")) return []
    // Claude reports every known bucket and sets the inactive ones to null.
    if (value === null || value === undefined) return []
    if (!record(value)) throw new Error(`Invalid Claude usage bucket: ${key}`)
    const used = percentage(value.utilization, key, false)
    if (used === undefined) return []
    const resetAt = reset(value.resets_at, `${key}.resets_at`)
    return [
      new ProviderUsage.Window({
        id: key.replaceAll("_", "-"),
        label: bucketLabel(key),
        unit: "percent",
        used,
        ...(resetAt === undefined ? {} : { resetAt }),
      }),
    ]
  })
  const seen = new Set(windows.map((window) => window.id))
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: accountLabel(input.label, input.subscriptionType),
    status: "available",
    source: "provider_internal_api",
    stability: "best_effort",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows: [...windows, ...scopedWindows(input.response.limits).filter((window) => !seen.has(window.id))],
  })
}

/**
 * Newer accounts report per-model weekly lanes only through `limits`, where the legacy
 * `seven_day_<model>` buckets stay null.
 */
function scopedWindows(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!record(entry) || entry.kind !== "weekly_scoped" || !record(entry.scope)) return []
    const model = record(entry.scope.model) ? entry.scope.model.display_name : undefined
    if (typeof model !== "string" || !model.trim()) return []
    const used = percentage(entry.percent, "limits.percent", false)
    if (used === undefined) return []
    const resetAt = reset(entry.resets_at, "limits.resets_at")
    return [
      new ProviderUsage.Window({
        id: `seven-day-${model.trim().toLowerCase().replaceAll(" ", "-")}`,
        label: `${model.trim()} weekly`,
        unit: "percent",
        used,
        ...(resetAt === undefined ? {} : { resetAt }),
      }),
    ]
  })
}

export function merge(primary: ProviderUsage.Snapshot, fallback: ProviderUsage.Snapshot) {
  const seen = new Set(primary.windows.map((window) => window.id))
  return new ProviderUsage.Snapshot({
    providerID: primary.providerID,
    label: primary.label,
    status: primary.status,
    source: primary.source,
    stability: primary.stability,
    updatedAt: Math.max(primary.updatedAt, fallback.updatedAt),
    windows: [...primary.windows, ...fallback.windows.filter((window) => !seen.has(window.id))],
    ...(primary.message === undefined ? {} : { message: primary.message }),
  })
}

function headerWindow(
  headers: Headers,
  id: string,
  label: string,
  prefix: string,
  resetHeader?: string,
) {
  const utilizationHeader = `${prefix}-utilization`
  const raw = headers.get(utilizationHeader)
  const used = raw === null ? derivedPercentage(headers, prefix) : percentage(raw, utilizationHeader, true)
  if (used === undefined) return []
  const resetAt = resetHeader ? reset(headers.get(resetHeader), resetHeader) : undefined
  return [
    new ProviderUsage.Window({
      id,
      label,
      unit: "percent",
      used,
      ...(resetAt === undefined ? {} : { resetAt }),
    }),
  ]
}

function derivedPercentage(headers: Headers, prefix: string) {
  const limitRaw = headers.get(`${prefix}-limit`)
  const remainingRaw = headers.get(`${prefix}-remaining`)
  if (limitRaw === null || remainingRaw === null) return undefined
  const limit = numeric(limitRaw, `${prefix}-limit`)
  const remaining = numeric(remainingRaw, `${prefix}-remaining`)
  if (limit <= 0 || remaining > limit) throw new Error(`Invalid Claude usage: ${prefix}`)
  return round(((limit - remaining) / limit) * 100)
}

function extraUsage(value: unknown) {
  if (!record(value) || value.is_enabled !== true) return []
  const used = cents(value.used_credits, "extra_usage.used_credits")
  const limit = cents(value.monthly_limit, "extra_usage.monthly_limit")
  if (used === undefined && limit === undefined) return []
  return [
    new ProviderUsage.Window({
      id: "extra-usage",
      label: "Extra usage",
      unit: "usd",
      ...(used === undefined ? {} : { used }),
      ...(limit === undefined ? {} : { limit }),
      ...(used === undefined || limit === undefined ? {} : { remaining: round(Math.max(limit - used, 0)) }),
    }),
  ]
}

function bucketLabel(key: string) {
  if (key === "five_hour") return "Session"
  if (key === "seven_day") return "All models"
  const model = key.slice("seven_day_".length)
  return `${model.charAt(0).toUpperCase()}${model.slice(1).replaceAll("_", " ")} weekly`
}

function accountLabel(label: string, subscriptionType: string | undefined) {
  const normalized = subscriptionType?.trim().toLowerCase()
  const accountType = normalized === "pro" ? "Pro" : normalized === "max" ? "Max" : undefined
  return accountType && !label.toLowerCase().includes(accountType.toLowerCase()) ? `${label} ${accountType}` : label
}

function percentage(value: unknown, field: string, ratio: boolean) {
  if (value === undefined || value === null) return undefined
  const number = numeric(value, field)
  if (number > 100) throw new Error(`Invalid Claude usage: ${field}`)
  return round(ratio && number <= 1 ? number * 100 : number)
}

function numeric(value: unknown, field: string) {
  const number = typeof value === "string" && value.trim() ? Number(value) : value
  if (typeof number !== "number" || !Number.isFinite(number) || number < 0)
    throw new Error(`Invalid Claude usage: ${field}`)
  return number
}

function cents(value: unknown, field: string) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error(`Invalid Claude usage: ${field}`)
  return round(value / 100)
}

function reset(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value === "number" && Number.isFinite(value) && value >= 0)
    return Math.trunc(value < 10_000_000_000 ? value * 1_000 : value)
  if (typeof value === "string") {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric >= 0)
      return Math.trunc(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  throw new Error(`Invalid Claude usage: ${field}`)
}

function round(value: number) {
  return Math.round(value * 100) / 100
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
