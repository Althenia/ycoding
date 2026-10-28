export * as UsageViewRecipe from "./usage-view-recipe"

import { createHash } from "node:crypto"
import { DateTime, Schema } from "effect"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Agent } from "./agent"
import { CatalogModel } from "./model"
import { Project } from "./project"
import { SessionSchema } from "./session/schema"
import { SessionUsage } from "./session/usage"
import type { SessionUsagePricing } from "./session/usage-pricing"
import type { Aggregate, PricingRef } from "./session/usage-read"
import type { UsageViewRowTable } from "./usage-view.sql"
import { localDate, localMidnight, usageReportGroup } from "./session/usage-projection"
import type { UsageAnalyticsRequestTable } from "./usage-analytics.sql"

export type Source = typeof UsageAnalyticsRequestTable.$inferSelect

export type Report = ProviderRequest.ReportInput

const timeGroups = new Set(["hour", "day", "month"])

export function state(input: Report): Report {
  return {
    group: input.group,
    ...(input.from === undefined ? {} : { from: input.from }),
    ...(input.to === undefined ? {} : { to: input.to }),
    ...(input.timeZone === undefined || !timeGroups.has(input.group) ? {} : { timeZone: input.timeZone }),
    ...(input.providerID === undefined ? {} : { providerID: input.providerID }),
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.modelID === undefined ? {} : { modelID: input.modelID }),
    ...(input.selectedEffort === undefined ? {} : { selectedEffort: input.selectedEffort }),
  }
}

export function presentation(input: Report): Report {
  return {
    ...state(input),
    sort: input.sort ?? "key",
    order: input.order ?? "asc",
    offset: input.offset ?? 0,
    limit: input.limit ?? 100,
  }
}

export const summaryState = JSON.stringify(state({ group: "model" }))

export const summaryPresentation = "summary"

export const measures = [
  "logical",
  "physical",
  "helpers",
  "continued",
  "fallback",
  "input",
  "output",
  "reasoning",
  "cache_read",
  "cache_write",
  "reported",
  "cost",
  "priced",
  "catalog_cost",
  "catalog_requests",
  "first_output",
  "total_output",
  "generation_samples",
  "provider_timed",
  "observed",
  "generation_tokens",
  "generation_duration",
  "generation_rate",
  "busy_ms",
  "failed",
  "cancelled",
  "outcomes",
] as const

export type Measures = Record<(typeof measures)[number], number>

export const quantiles = [
  { metric: 0, percent: 50 },
  { metric: 0, percent: 95 },
  { metric: 1, percent: 50 },
  { metric: 1, percent: 95 },
  { metric: 2, percent: 50 },
  { metric: 2, percent: 90 },
  { metric: 0, percent: 99 },
  { metric: 1, percent: 99 },
  { metric: 2, percent: 95 },
] as const

export const sizes = ["first_output", "total_output", "generation_samples"] as const

export const sorts: Readonly<Record<string, string>> = {
  cost: "total_cost",
  tokens: "total_tokens",
  steps: "logical",
  input: "input",
  output: "output",
  reasoning: "reasoning",
  cacheRead: "cache_read",
  cacheWrite: "cache_write",
}

export const target = (size: number, percent: number) => Math.floor((size * percent + 99) / 100)

export const decodeModel = Schema.decodeUnknownSync(Schema.fromJsonString(CatalogModel.Ref))
export const decodeTasks = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(SessionSchema.ID)))
export const decodeRecipe = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderRequest.ReportInput))
export const encodeReport = Schema.encodeSync(Schema.fromJsonString(ProviderRequest.Report))
export const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderRequest.Report))
export const encodeSummary = Schema.encodeSync(Schema.fromJsonString(ProviderRequest.Summary))
export const decodeSummary = Schema.decodeUnknownSync(Schema.fromJsonString(ProviderRequest.Summary))

export const Latest = Schema.Struct({
  time: Schema.Number,
  updated: Schema.Number,
  session: Schema.String,
  request: Schema.Number,
  invalidation: ProviderRequest.Invalidation,
  namespace: Schema.String,
  timing: Schema.NullOr(Schema.String),
})
export interface Latest extends Schema.Schema.Type<typeof Latest> {}
export const decodeLatest = Schema.decodeUnknownSync(Schema.fromJsonString(Latest))

const RefKey = Schema.Tuple([Schema.String, Schema.NullOr(Schema.String), Schema.String, Schema.String, Schema.NullOr(Schema.String)])
const decodeRefKey = Schema.decodeUnknownSync(Schema.fromJsonString(RefKey))

export const decodeRef = (key: string): PricingRef => {
  const [directory, workspaceID, provider, model, profile] = decodeRefKey(key)
  return { key, directory, workspaceID, provider, model, profile }
}

export const price = (entry: SessionUsagePricing.Entry | undefined) =>
  createHash("sha256").update(JSON.stringify(entry ?? null)).digest("hex")

export const digest = (refs: ReadonlyArray<{ readonly ref: string; readonly price: string }>) =>
  createHash("sha256")
    .update(JSON.stringify(refs.map((item) => [item.ref, item.price]).toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))))
    .digest("hex")
export const encodeLatest = Schema.encodeSync(Schema.fromJsonString(Latest))

export function priceKey(location: { readonly directory: string; readonly workspaceID: string | null }, model: CatalogModel.Ref) {
  return JSON.stringify([location.directory, location.workspaceID, model.providerID, model.id, model.profile ?? null])
}

export const locationKey = (location: { readonly directory: string; readonly workspaceID: string | null }) =>
  JSON.stringify([location.directory, location.workspaceID])

export type Contribution = {
  readonly measures: Measures
  readonly samples: ReadonlyArray<readonly [metric: number, value: number]>
  readonly ref?: { readonly location: string; readonly key: string; readonly provider: string; readonly model: string; readonly profile: string | null; readonly directory: string; readonly workspaceID: string | null }
}

export const zero = (): Measures => ({
  logical: 0,
  physical: 0,
  helpers: 0,
  continued: 0,
  fallback: 0,
  input: 0,
  output: 0,
  reasoning: 0,
  cache_read: 0,
  cache_write: 0,
  reported: 0,
  cost: 0,
  priced: 0,
  catalog_cost: 0,
  catalog_requests: 0,
  first_output: 0,
  total_output: 0,
  generation_samples: 0,
  provider_timed: 0,
  observed: 0,
  generation_tokens: 0,
  generation_duration: 0,
  generation_rate: 0,
  busy_ms: 0,
  failed: 0,
  cancelled: 0,
  outcomes: 0,
})

const exact = (value: number | undefined): value is number =>
  value !== undefined && value > 0 && value <= Number.MAX_SAFE_INTEGER && Number.isInteger(value)

export function contribution(
  row: Source,
  pricing: ReadonlyMap<string, SessionUsagePricing.Entry | undefined>,
): Contribution {
  const tokens = row.tokens
  const timing = row.timing ?? undefined
  const model = row.model
  const value = zero()
  Object.assign(value, {
    logical: 1,
    physical: row.attempts,
    helpers: row.source === "step" ? 0 : 1,
    continued: row.continuation === "continued" ? 1 : 0,
    fallback: row.continuation === "fallback" ? 1 : 0,
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache_read: tokens.cache.read,
    cache_write: tokens.cache.write,
    reported: row.cache_read_reported ? 1 : 0,
    cost: row.cost ?? 0,
    priced: row.cost === null ? 0 : 1,
    failed: row.outcome === "failed" ? 1 : 0,
    cancelled: row.outcome === "cancelled" ? 1 : 0,
    outcomes: row.outcome === null ? 0 : 1,
  })
  const location = { directory: row.directory, workspaceID: row.workspace_id }
  const ref =
    row.cost === null && row.source !== "decision"
      ? {
          location: locationKey(location),
          key: priceKey(location, model),
          provider: model.providerID,
          model: model.id,
          profile: model.profile ?? null,
          ...location,
        }
      : undefined
  if (ref) {
    const entry = pricing.get(ref.key)
    const price = entry
      ? SessionUsage.estimatedCatalogCost(entry.provider, entry.router, tokens, tokens.input + tokens.cache.read + tokens.cache.write)?.cost
      : undefined
    if (price !== undefined) {
      value.catalog_cost = price
      value.catalog_requests = 1
    }
  }
  const samples: Array<readonly [number, number]> = []
  const first = timing?.firstOutputMs
  const total = timing?.totalMs
  if (first !== undefined) {
    value.first_output = 1
    samples.push([0, first])
  }
  if (total !== undefined) {
    value.total_output = 1
    value.busy_ms = total
    samples.push([1, total])
  }
  const providerTimed = timing !== undefined && Object.hasOwn(timing, "generationDurationNs")
  const observed = timing?.observedGenerationDurationNs
  const duration = providerTimed
    ? timing?.generationDurationNs
    : observed !== undefined && observed >= 1_000_000_000
      ? observed
      : undefined
  const generated = timing?.generatedTokens
  if (exact(duration) && exact(generated)) {
    value.generation_samples = 1
    value.provider_timed = providerTimed ? 1 : 0
    value.observed = providerTimed ? 0 : 1
    value.generation_tokens = generated
    value.generation_duration = duration
    value.generation_rate = (generated * 1_000_000_000) / duration
    samples.push([2, value.generation_rate])
  }
  return { measures: value, samples, ...(ref ? { ref } : {}) }
}

export function matches(recipe: Report, row: Source) {
  if (recipe.from !== undefined && row.time_created < recipe.from) return false
  if (recipe.to !== undefined && row.time_created >= recipe.to) return false
  const model = row.model
  if (recipe.providerID !== undefined && model.providerID !== recipe.providerID) return false
  if (recipe.profile !== undefined && model.profile !== recipe.profile) return false
  if (recipe.modelID !== undefined && model.id !== recipe.modelID) return false
  if (recipe.selectedEffort !== undefined && model.variant !== recipe.selectedEffort) return false
  return true
}

export function keys(recipe: Report, row: Source, formatter: Intl.DateTimeFormat | undefined) {
  const record = {
    model: row.model,
    agent: Agent.ID.make(row.agent),
    time: DateTime.makeUnsafe(row.time_created),
    usageAnchor: row.usage_anchor ?? undefined,
  }
  const session = {
    id: SessionSchema.ID.make(row.session_id),
    title: row.session_id,
    projectID: Project.ID.make(row.project_id),
  }
  const tasks = recipe.group === "task" ? row.task_path.map((id) => SessionSchema.ID.make(id)) : []
  return [
    ...new Set(
      (tasks.length === 0 ? [undefined] : tasks).map(
        (taskID) => usageReportGroup(recipe.group, { record, session, taskID }, [], formatter).key,
      ),
    ),
  ]
}

export type ViewRow = typeof UsageViewRowTable.$inferSelect

export function aggregate(row: ViewRow): Aggregate {
  return {
    key: row.key,
    sessionID: row.session_id,
    title: row.title,
    projectID: row.project_id,
    model: row.model,
    agent: row.agent,
    time: row.time,
    logical: row.logical,
    physical: row.physical,
    helpers: row.helpers,
    continued: row.continued,
    fallback: row.fallback,
    input: row.input,
    output: row.output,
    reasoning: row.reasoning,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    cost: row.cost + row.catalog_cost,
    priced: row.priced + row.catalog_requests,
    cacheReadReported: row.reported === row.logical ? 1 : 0,
    currentCatalog: row.catalog_requests > 0 ? 1 : 0,
    failed: row.failed,
    cancelled: row.cancelled,
    outcomes: row.outcomes,
  }
}

export function speed(row: ViewRow, ranks: ReadonlyMap<number, number>): ProviderRequest.Speed | undefined {
  const first = row.first_output
  const total = row.total_output
  const generation = row.generation_samples
  const duration = row.generation_duration
  if (first === 0 && total === 0 && duration === 0) return undefined
  return {
    samples: first,
    generationSamples: generation,
    providerTimedSamples: row.provider_timed,
    observedSamples: row.observed,
    ...(generation > 0
      ? {
          generationP50TokensPerSecond: ranks.get(4)!,
          generationP90TokensPerSecond: ranks.get(5)!,
          generationP95TokensPerSecond: ranks.get(8)!,
          meanTokensPerSecond: row.generation_rate / generation,
        }
      : {}),
    ...(first > 0 ? { firstOutputP50Ms: ranks.get(0)!, firstOutputP95Ms: ranks.get(1)!, firstOutputP99Ms: ranks.get(6)! } : {}),
    ...(total > 0 ? { totalP50Ms: ranks.get(2)!, totalP95Ms: ranks.get(3)!, totalP99Ms: ranks.get(7)! } : {}),
    ...(duration === 0 ? {} : { outputTokensPerSecond: row.generation_tokens / (duration / 1_000_000_000) }),
  }
}

const day = 86_400_000

export function bounds(now: number, timeZone: string | undefined, days = 30) {
  const formatter =
    timeZone === undefined
      ? undefined
      : new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  const date = formatter
    ? localDate(now, formatter)
    : { year: new Date(now).getUTCFullYear(), month: new Date(now).getUTCMonth() + 1, day: new Date(now).getUTCDate() }
  const today = Date.UTC(date.year, date.month - 1, date.day)
  const start = new Date(today - (days - 1) * day)
  const tomorrow = new Date(today + day)
  return {
    from: formatter ? localMidnight(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate(), formatter) : start.getTime(),
    to: formatter
      ? localMidnight(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), formatter)
      : tomorrow.getTime(),
    monthFrom: formatter ? localMidnight(date.year, date.month, 1, formatter) : Date.UTC(date.year, date.month - 1, 1),
  }
}

export function standard(now: number, timeZone: string | undefined): ReadonlyArray<Report> {
  const range = bounds(now, timeZone)
  const zone = timeZone === undefined ? {} : { timeZone }
  return [
    { group: "day", from: range.from, to: range.to, ...zone, limit: 30, sort: "key", order: "asc" },
    { group: "model", from: range.monthFrom, to: range.to, ...zone, limit: 200, sort: "cost", order: "desc" },
    { group: "model", from: range.from, to: range.to, ...zone, offset: 0, limit: 25, sort: "cost", order: "desc" },
  ]
}
