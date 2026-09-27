export * as CopilotUsage from "./copilot"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderV2 } from "../provider"
import { Option, Schema } from "effect"

const userStatusPath = "/copilot_internal/user"
const orgsPath = "/user/orgs"

export class RequestError extends Schema.TaggedErrorClass<RequestError>()("CopilotUsage.RequestError", {
  status: Schema.Number,
  retryAfter: Schema.Number.pipe(Schema.optional),
}) {}

const QuotaSnapshot = Schema.Struct({
  entitlement: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
  quota_remaining: Schema.optional(Schema.Number),
  percent_remaining: Schema.optional(Schema.Number),
  overage_count: Schema.optional(Schema.Number),
  overage_permitted: Schema.optional(Schema.Boolean),
  credits_used: Schema.optional(Schema.Number),
  unlimited: Schema.optional(Schema.Boolean),
})

const UserStatus = Schema.Struct({
  copilot_plan: Schema.optional(Schema.String),
  token_based_billing: Schema.optional(Schema.Boolean),
  quota_reset_date: Schema.optional(Schema.String),
  quota_reset_date_utc: Schema.optional(Schema.String),
  quota_snapshots: Schema.optional(Schema.Record(Schema.String, Schema.Union([QuotaSnapshot, Schema.Null]))),
  limited_user_quotas: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  monthly_quotas: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  limited_user_reset_date: Schema.optional(Schema.String),
})

const Orgs = Schema.Array(Schema.Struct({ login: Schema.String }))

const UsageItem = Schema.Struct({
  product: Schema.optional(Schema.String),
  unitType: Schema.optional(Schema.String),
  grossQuantity: Schema.optional(Schema.Number),
  netAmount: Schema.optional(Schema.Number),
})

const BillingSummary = Schema.Struct({
  organization: Schema.optional(Schema.String),
  usageItems: Schema.Array(UsageItem),
})

type QuotaSnapshotType = Schema.Schema.Type<typeof QuotaSnapshot>
type BillingSummaryType = Schema.Schema.Type<typeof BillingSummary>
type UsageItemType = Schema.Schema.Type<typeof UsageItem>

export interface SnapshotInput {
  readonly providerID: ProviderV2.ID
  readonly label: string
  readonly updatedAt: number
}

export interface NormalizeQuotaInput extends SnapshotInput {
  readonly response: unknown
}

export interface NormalizeBillingInput extends SnapshotInput {
  readonly response: unknown
}

export interface LoadInput extends SnapshotInput {
  readonly matchedOrg?: string
  readonly request: (path: string) => Promise<{ readonly status: number; readonly body: unknown }>
}

export interface LoadResult {
  readonly snapshot: ProviderUsage.Snapshot
  readonly matchedOrg: string | undefined
}

export interface BillingResult {
  readonly snapshot: ProviderUsage.Snapshot
  readonly matched: boolean
}

export async function load(input: LoadInput): Promise<LoadResult> {
  const status = requireSuccess(await input.request(userStatusPath))
  const decoded = userStatus(status.body)
  const personal = normalizeQuota({ ...input, response: status.body })
  if (decoded.token_based_billing === true && !personal.windows.some((window) => window.id === "credits" && window.unit === "percent")) {
    const organization = await orgUsage(input)
    if (personal.windows.length === 0 && organization.snapshot.windows.length > 0) return organization
    return {
      snapshot: new ProviderUsage.Snapshot({
        providerID: personal.providerID, label: personal.label, status: personal.status,
        source: personal.source, stability: personal.stability, updatedAt: personal.updatedAt,
        windows: [...personal.windows, ...organization.snapshot.windows],
      }),
      matchedOrg: organization.matchedOrg,
    }
  }
  return {
    snapshot: personal,
    matchedOrg: undefined,
  }
}

export function normalizeQuota(input: NormalizeQuotaInput) {
  const status = userStatus(input.response)
  const resetAt = resetDate(status.quota_reset_date ?? status.quota_reset_date_utc)
  const quota = status.quota_snapshots ?? {}
  const premium = quota.premium_interactions
  const credits = premium ? creditWindow(premium, resetAt, status.token_based_billing === true) : undefined
  const windows = [
    ...(credits ? [credits] : []),
    ...(credits?.unit === "percent" && premium?.overage_permitted === true && premium.overage_count !== undefined
      ? [new ProviderUsage.Window({ id: "extra-usage", label: "Extra usage", unit: "count", used: nonNegative(premium.overage_count, "overage_count") })]
      : []),
    ...(["chat", "completions"] as const).flatMap((key) => quota[key] ? quotaWindows(key, quota[key], resetAt) : []),
  ]
  if (!windows.length && (status.limited_user_quotas !== undefined || status.monthly_quotas !== undefined))
    return limitedSnapshot(input, status)
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: "provider_internal_api",
    stability: "best_effort",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows,
  })
}

export function normalizeBilling(input: NormalizeBillingInput): BillingResult {
  const summary = billingSummary(input.response)
  return billingResult(input, aiCreditEntries(summary))
}

async function orgUsage(input: LoadInput): Promise<LoadResult> {
  if (input.matchedOrg) {
    const remembered = await orgSummary(input, input.matchedOrg)
    if (remembered) return remembered
  }
  const response = await input.request(orgsPath).catch(() => ({ status: 0, body: null }))
  if (response.status < 200 || response.status >= 300) return { snapshot: available(input, []), matchedOrg: undefined }
  const orgs = undefine(decodeOrgs(response.body))
  const logins = (orgs ?? []).map((entry) => entry.login).filter((login) => login !== input.matchedOrg)
  for (const login of logins) {
    const result = await orgSummary(input, login)
    if (result) return result
  }
  return { snapshot: available(input, []), matchedOrg: undefined }
}

async function orgSummary(input: LoadInput, login: string): Promise<LoadResult | undefined> {
  const response = await input.request(`/orgs/${encodeURIComponent(login)}/settings/billing/usage/summary`)
    .catch(() => ({ status: 0, body: null }))
  if (response.status < 200 || response.status >= 300) return undefined
  const summary = undefine(decodeBilling(response.body))
  if (!summary) return undefined
  const result = billingResult(input, aiCreditEntries(summary))
  return result.matched ? { snapshot: result.snapshot, matchedOrg: login } : undefined
}

function billingResult(input: SnapshotInput, entries: ReadonlyArray<UsageItemType>): BillingResult {
  const credits = total(entries, (entry) => nonNegative(entry.grossQuantity, "grossQuantity"))
  const spend = total(entries, (entry) => nonNegative(entry.netAmount, "netAmount"))
  const windows = [
    ...(credits === undefined ? [] : [new ProviderUsage.Window({ id: "org-credits", label: "Org credits", unit: "count", used: credits })]),
    ...(spend === undefined ? [] : [new ProviderUsage.Window({ id: "org-spend", label: "Org spend", unit: "usd", used: spend })]),
  ]
  return { matched: windows.length > 0, snapshot: available(input, windows) }
}

function limitedSnapshot(input: NormalizeQuotaInput, status: Schema.Schema.Type<typeof UserStatus>) {
  const resetAt = resetDate(status.limited_user_reset_date)
  const limited = status.limited_user_quotas ?? {}
  const monthly = status.monthly_quotas ?? {}
  const windows = (["chat", "completions"] as const).flatMap((key) => {
    const prefix = key === "chat" ? ["chat", "chat_completion", "chat_completions"] : ["completions", "code_completion", "code_completions"]
    const remaining = prefix.map((name) => limited[name]).find((value) => value !== undefined)
    const limit = prefix.map((name) => monthly[name]).find((value) => value !== undefined)
    if (remaining === undefined || limit === undefined || limit <= 0) return []
    const used = nonNegative(remaining, key)
    if (used === undefined) return []
    return [new ProviderUsage.Window({
      id: key, label: key === "chat" ? "Chat" : "Completions", unit: "percent",
      used: round(Math.max(0, (1 - used / limit) * 100)),
      ...(resetAt === undefined ? {} : { resetAt }),
    })]
  })
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: "provider_internal_api",
    stability: "best_effort",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows,
  })
}

function quotaWindows(key: string, value: QuotaSnapshotType, resetAt: number | undefined) {
  if (value.unlimited === true || value.entitlement === -1 || value.remaining === -1 || value.quota_remaining === -1 || value.entitlement === 0) return []
  const used =
    percent(value.percent_remaining, key) ?? derived(value, key)
  const remaining = nonNegative(value.remaining ?? value.quota_remaining, key)
  const limitValue = limit(value, key)
  const windows = []
  if (used !== undefined)
    windows.push(
      new ProviderUsage.Window({
        id: safeID(key),
        label: laneLabel(key),
        unit: "percent",
        ...(used === undefined ? {} : { used }),
        ...(remaining === undefined ? {} : { remaining }),
        ...(limitValue === undefined ? {} : { limit: limitValue }),
        ...(resetAt === undefined ? {} : { resetAt }),
      }),
    )
  return windows
}

function creditWindow(value: QuotaSnapshotType, resetAt: number | undefined, orgManaged: boolean) {
  if (value.entitlement === 0 && orgManaged) {
    const used = nonNegative(value.credits_used, "credits_used")
    return used === undefined ? undefined : new ProviderUsage.Window({
      id: "credits", label: "AI credits", unit: "count", used,
    })
  }
  const window = quotaWindows("credits", value, resetAt)[0]
  return window
}

function aiCreditEntries(summary: BillingSummaryType) {
  return summary.usageItems.filter((entry) => {
    if (entry.product?.toLowerCase() !== "copilot" || !["ai-units", "ai-credits"].includes(entry.unitType?.toLowerCase() ?? "")) return false
    nonNegative(entry.grossQuantity, "grossQuantity")
    nonNegative(entry.netAmount, "netAmount")
    return true
  })
}

function total(values: ReadonlyArray<UsageItemType>, select: (value: UsageItemType) => number | undefined) {
  const present = values.flatMap((value) => {
    const item = select(value)
    return item === undefined ? [] : [item]
  })
  if (!present.length) return undefined
  return present.reduce((sum, value) => sum + value, 0)
}

function percent(value: number | undefined, key: string) {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0 || value > 100)
    throw new Error(`Invalid Copilot usage response: ${key}.percent_remaining`)
  return round(100 - value)
}

function derived(value: QuotaSnapshotType, key: string) {
  const entitlement = value.entitlement
  const remaining = value.remaining ?? value.quota_remaining
  if (entitlement === undefined || remaining === undefined) return undefined
  if (!Number.isFinite(entitlement) || !Number.isFinite(remaining) || entitlement < 0 || remaining < 0)
    throw new Error(`Invalid Copilot usage response: ${key}`)
  if (entitlement === 0) return undefined
  if (remaining > entitlement) throw new Error(`Invalid Copilot usage response: ${key}`)
  return round((1 - remaining / entitlement) * 100)
}

function limit(value: QuotaSnapshotType, key: string) {
  return nonNegative(value.entitlement, `${key}.entitlement`)
}

function nonNegative(value: number | undefined, field: string) {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid Copilot usage response: ${field}`)
  return value
}

function resetDate(value: string | undefined) {
  if (value === undefined || value === "") return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("Invalid Copilot usage response")
  return parsed
}

function requireSuccess(response: { readonly status: number; readonly body: unknown }) {
  if (response.status < 200 || response.status >= 300)
    throw new RequestError({
      status: response.status,
    })
  return response
}

const decodeUserStatus = Schema.decodeUnknownOption(UserStatus, { onExcessProperty: "ignore" })
const decodeOrgs = Schema.decodeUnknownOption(Orgs, { onExcessProperty: "ignore" })
const decodeBilling = Schema.decodeUnknownOption(BillingSummary, { onExcessProperty: "ignore" })

function userStatus(value: unknown) {
  const status = undefine(decodeUserStatus(value))
  if (status === undefined) throw new Error("Invalid Copilot usage response")
  return status
}

function billingSummary(value: unknown) {
  const summary = undefine(decodeBilling(value))
  if (summary === undefined) throw new Error("Invalid Copilot usage response")
  return summary
}

function undefine<A>(option: Option.Option<A>) {
  return Option.match(option, { onNone: () => undefined, onSome: (value) => value })
}

function laneLabel(key: string) {
  const names: Readonly<Record<string, string>> = {
    chat: "Chat",
    completions: "Completions",
    credits: "AI credits",
  }
  return (
    names[key] ??
    key
      .split("_")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  )
}

function available(input: SnapshotInput, windows: ReadonlyArray<ProviderUsage.Window>) {
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: "provider_api",
    stability: "stable",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows,
  })
}

function safeID(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
