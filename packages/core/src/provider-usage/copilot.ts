export * as CopilotUsage from "./copilot"

import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { ProviderV2 } from "../provider"
import { Option, Schema } from "effect"

// GitHub bills AI credits at a fixed rate: 1 credit = $0.01 USD.
export const CREDIT_TO_USD = 0.01

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
  unlimited: Schema.optional(Schema.Boolean),
})

// Legacy pre-June-2026 premium/chat/completions allowances. Values are raw
// counts, never AI credits; the AI-credit usage comes from the org billing API.
const UserStatus = Schema.Struct({
  copilot_plan: Schema.optional(Schema.String),
  access_type_sku: Schema.optional(Schema.String),
  quota_reset_date: Schema.optional(Schema.String),
  quota_reset_date_utc: Schema.optional(Schema.String),
  quota_snapshots: Schema.optional(Schema.Record(Schema.String, Schema.Union([QuotaSnapshot, Schema.Null]))),
  limited_user_quotas: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  monthly_quotas: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  limited_user_reset_date: Schema.optional(Schema.String),
})

const Orgs = Schema.Array(Schema.Struct({ login: Schema.String }))

const UsageItem = Schema.Struct({
  aic_quantity: Schema.optional(Schema.Number),
  aic_gross_amount: Schema.optional(Schema.Number),
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
  if (tokenBasedBilling(decoded)) return orgUsage(input)
  return {
    snapshot: normalizeQuota({
      providerID: input.providerID,
      label: input.label,
      updatedAt: input.updatedAt,
      response: status.body,
    }),
    matchedOrg: undefined,
  }
}

/**
 * Paid-tier legacy quota snapshots and free limited-user quotas. The org
 * token-based-billing placeholder is routed to `load`, never normalized here.
 */
export function normalizeQuota(input: NormalizeQuotaInput) {
  const status = userStatus(input.response)
  if (status.limited_user_quotas !== undefined || status.monthly_quotas !== undefined)
    return limitedSnapshot(input, status)
  const resetAt = resetDate(status.quota_reset_date ?? status.quota_reset_date_utc)
  const windows = Object.entries(status.quota_snapshots ?? {}).flatMap(([key, value]) =>
    value === null ? [] : quotaWindows(key, value, resetAt),
  )
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
  const orgs = undefine(decodeOrgs(requireSuccess(await input.request(orgsPath)).body))
  const logins = (orgs ?? []).map((entry) => entry.login).filter((login) => login !== input.matchedOrg)
  for (const login of logins) {
    const result = await orgSummary(input, login)
    if (result) return result
  }
  return { snapshot: available(input, []), matchedOrg: undefined }
}

async function orgSummary(input: LoadInput, login: string): Promise<LoadResult | undefined> {
  const response = await input.request(`/orgs/${encodeURIComponent(login)}/settings/billing/usage/summary`)
  if (response.status < 200 || response.status >= 300) return undefined
  const summary = undefine(decodeBilling(response.body))
  if (!summary) return undefined
  const result = billingResult(input, aiCreditEntries(summary))
  return result.matched ? { snapshot: result.snapshot, matchedOrg: login } : undefined
}

function billingResult(input: SnapshotInput, entries: ReadonlyArray<UsageItemType>): BillingResult {
  const credits = total(entries, (entry) => nonNegative(entry.aic_quantity, "aic_quantity"))
  const spend = total(entries, (entry) => nonNegative(entry.aic_gross_amount, "aic_gross_amount"))
  const derivedSpend = spend ?? (credits === undefined ? undefined : round(credits * CREDIT_TO_USD))
  const windows = [
    ...(credits === undefined
      ? []
      : [
          new ProviderUsage.Window({
            id: "ai-credits",
            label: "AI credits",
            unit: "count",
            used: credits,
          }),
        ]),
    ...(derivedSpend === undefined
      ? []
      : [
          new ProviderUsage.Window({
            id: "ai-credit-spend",
            label: "AI credit spend",
            unit: "usd",
            used: derivedSpend,
          }),
        ]),
  ]
  return { matched: entries.length > 0, snapshot: available(input, windows) }
}

function limitedSnapshot(input: NormalizeQuotaInput, status: Schema.Schema.Type<typeof UserStatus>) {
  const resetAt = resetDate(status.limited_user_reset_date)
  const limited = Object.entries(status.limited_user_quotas ?? {}).map(([key, value]) =>
    new ProviderUsage.Window({
      id: safeID(key),
      label: limitedLabel(key),
      unit: "count",
      remaining: nonNegative(value, key),
      ...(resetAt === undefined ? {} : { resetAt }),
    }),
  )
  const monthly = Object.entries(status.monthly_quotas ?? {}).map(([key, value]) =>
    new ProviderUsage.Window({
      id: safeID(key),
      label: limitedLabel(key),
      unit: "count",
      remaining: nonNegative(value, key),
      ...(resetAt === undefined ? {} : { resetAt }),
    }),
  )
  return new ProviderUsage.Snapshot({
    providerID: input.providerID,
    label: input.label,
    status: "available",
    source: "provider_internal_api",
    stability: "best_effort",
    updatedAt: Math.max(0, Math.trunc(input.updatedAt)),
    windows: [...limited, ...monthly.filter((window) => !limited.some((item) => item.id === window.id))],
  })
}

function quotaWindows(key: string, value: QuotaSnapshotType, resetAt: number | undefined) {
  const used =
    value.unlimited === true ? undefined : percent(value.percent_remaining, key) ?? derived(value, key)
  const remaining = nonNegative(value.remaining ?? value.quota_remaining, key)
  const limitValue = limit(value, key)
  const windows = []
  if (used !== undefined || remaining !== undefined || limitValue !== undefined || value.unlimited === true)
    windows.push(
      new ProviderUsage.Window({
        id: safeID(key),
        label: laneLabel(key),
        unit: "percent",
        ...(used === undefined ? {} : { used }),
        ...(remaining === undefined ? {} : { remaining }),
        ...(limitValue === undefined ? {} : { limit: limitValue }),
        ...(value.unlimited === true ? { unlimited: true } : {}),
        ...(resetAt === undefined ? {} : { resetAt }),
      }),
    )
  if (value.overage_count !== undefined)
    windows.push(
      new ProviderUsage.Window({
        id: `${safeID(key)}-overage`,
        label: `${laneLabel(key)} overage`,
        unit: "count",
        used: nonNegative(value.overage_count, `${key}.overage_count`),
      }),
    )
  return windows
}

function aiCreditEntries(summary: BillingSummaryType) {
  return summary.usageItems.filter(
    (entry) => entry.aic_quantity !== undefined || entry.aic_gross_amount !== undefined,
  )
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

function tokenBasedBilling(status: Schema.Schema.Type<typeof UserStatus>) {
  return status.access_type_sku?.toLowerCase().replaceAll("_", "-") === "token-based-billing"
}

function undefine<A>(option: Option.Option<A>) {
  return Option.match(option, { onNone: () => undefined, onSome: (value) => value })
}

function laneLabel(key: string) {
  const names: Readonly<Record<string, string>> = {
    chat: "Chat",
    completions: "Completions",
    premium_interactions: "Premium interactions",
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

function limitedLabel(key: string) {
  if (key === "chat_completion" || key === "chat_completions") return "Chat completions"
  if (key === "code_completion" || key === "code_completions") return "Code completions"
  return laneLabel(key)
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
