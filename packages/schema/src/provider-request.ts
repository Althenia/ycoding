export * as ProviderRequest from "./provider-request.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Model } from "./model.js"
import { Money } from "./money.js"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt } from "./schema.js"
import { SessionID } from "./session-id.js"
import { ID as SessionMessageID } from "./session-message-id.js"
import { TokenUsage } from "./token-usage.js"

export const ID = Schema.String.check(Schema.isStartsWith("prq_")).pipe(
  Schema.brand("ProviderRequest.ID"),
  Schema.annotate({ identifier: "ProviderRequest.ID" }),
)
export type ID = typeof ID.Type

export const Source = Schema.Literals(["step", "title", "goal", "compaction"])
export type Source = typeof Source.Type

export const Invalidation = Schema.Literals([
  "first-request",
  "compaction-reset",
  "model-switched",
  "model-variant-switched",
  "stable-hit",
  "prefix-changed",
  "system-prefix-changed",
  "tool-prefix-changed",
  "below-minimum",
  "provider-not-reported",
  "cache-disabled",
  "retry-fallback",
])
export type Invalidation = typeof Invalidation.Type

export const Continuation = Schema.Literals(["full", "continued", "fallback"])
export type Continuation = typeof Continuation.Type

export const CostProvenance = Schema.Literals(["recorded", "current_catalog"])
export type CostProvenance = typeof CostProvenance.Type

export const ReportGroup = Schema.Literals(["model", "hour", "day", "month", "session", "project", "agent"])
export type ReportGroup = typeof ReportGroup.Type

export const ReportSort = Schema.Literals(["key", "tokens", "cost"])
export type ReportSort = typeof ReportSort.Type

export const ReportOrder = Schema.Literals(["asc", "desc"])
export type ReportOrder = typeof ReportOrder.Type

const ReportLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(200))

export const ReportInput = Schema.Struct({
  group: ReportGroup,
  /** Inclusive UTC epoch-millisecond lower bound. */
  from: NonNegativeInt.pipe(optional),
  /** Exclusive UTC epoch-millisecond upper bound. */
  to: NonNegativeInt.pipe(optional),
  offset: NonNegativeInt.pipe(optional),
  limit: ReportLimit.pipe(optional),
  sort: ReportSort.pipe(optional),
  order: ReportOrder.pipe(optional),
})
  .check(
    Schema.makeFilter((value) => value.from === undefined || value.to === undefined || value.from < value.to, {
      expected: "from before to",
      meta: { _tag: "isMaxProperties", maxProperties: 7 },
      arbitrary: { constraint: { maxLength: 7 } },
    }),
  )
  .annotate({ identifier: "ProviderRequest.ReportInput" })
export interface ReportInput extends Schema.Schema.Type<typeof ReportInput> {}

export const Record = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  inputID: SessionMessageID.pipe(optional),
  source: Source,
  agent: Agent.ID,
  model: Model.Ref,
  routeID: Schema.String,
  promptCacheKey: Schema.String,
  systemDigest: Schema.String,
  toolDigest: Schema.String,
  request: PositiveInt,
  attempts: PositiveInt,
  invalidation: Invalidation,
  continuation: Continuation,
  /** Whether the provider explicitly reported cache-read usage; absent for historical records. */
  cacheReadReported: Schema.Boolean.pipe(optional),
  /** Persisted provider-reported USD cost. */
  cost: Money.USD.pipe(optional),
  tokens: TokenUsage.Info,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "ProviderRequest.Record" })
export interface Record extends Schema.Schema.Type<typeof Record> {}

export const ModelSpend = Schema.Struct({
  model: Model.Ref,
  requests: NonNegativeInt,
  /** Raw provider-reported usage aggregated for this exact provider/model/variant. */
  tokens: TokenUsage.Info,
  /** True only when every request for this model explicitly reported cache-read usage. */
  cacheReadReported: Schema.Boolean.pipe(optional),
  /** Absent when any request in the group has neither persisted nor catalog-estimated cost. */
  cost: Money.USD.pipe(optional),
  /** Recorded provider billing or a query-time current-catalog estimate; required when cost is present. */
  costProvenance: CostProvenance.pipe(optional),
})
  .check(
    Schema.makeFilter((value) => (value.cost === undefined) === (value.costProvenance === undefined), {
      expected: "cost and cost provenance together",
      meta: { _tag: "isMaxProperties", maxProperties: 6 },
      arbitrary: { constraint: { maxLength: 6 } },
    }),
  )
  .annotate({ identifier: "ProviderRequest.ModelSpend" })
export interface ModelSpend extends Schema.Schema.Type<typeof ModelSpend> {}

export const Summary = Schema.Struct({
  logical: NonNegativeInt,
  physical: NonNegativeInt,
  helpers: NonNegativeInt,
  continued: NonNegativeInt,
  fallback: NonNegativeInt,
  /** True only when every contributing request explicitly reported cache-read usage. */
  cacheReadReported: Schema.Boolean.pipe(optional),
  cost: Money.USD.pipe(optional),
  /**
   * Spend grouped by model, ordered by descending cost then by provider, model, and variant.
   * Absent when the session recorded no provider requests.
   */
  models: Schema.Array(ModelSpend).pipe(optional),
  tokens: TokenUsage.Info,
  latestInvalidation: Invalidation.pipe(optional),
  latestNamespace: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(8)).pipe(optional),
}).annotate({ identifier: "ProviderRequest.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

const ReportMetricsFields = {
  logical: NonNegativeInt,
  physical: NonNegativeInt,
  helpers: NonNegativeInt,
  continued: NonNegativeInt,
  fallback: NonNegativeInt,
  tokens: TokenUsage.Info,
  /** Absent when any contributing request has no recorded or current-catalog-estimated cost. */
  cost: Money.USD.pipe(optional),
  /** Required exactly when cost is present. */
  costProvenance: CostProvenance.pipe(optional),
  /** True only when every contributing request explicitly reported cache-read usage. */
  cacheReadReported: Schema.Boolean.pipe(optional),
}

const costAndProvenanceTogether = (maxProperties: number) =>
  Schema.makeFilter(
    (value: { readonly cost?: Money.USD; readonly costProvenance?: CostProvenance }) =>
      (value.cost === undefined) === (value.costProvenance === undefined),
    {
      expected: "cost and cost provenance together",
      meta: { _tag: "isMaxProperties", maxProperties },
      arbitrary: { constraint: { maxLength: maxProperties } },
    },
  )

export const ReportMetrics = Schema.Struct(ReportMetricsFields)
  .check(costAndProvenanceTogether(9))
  .annotate({ identifier: "ProviderRequest.ReportMetrics" })
export interface ReportMetrics extends Schema.Schema.Type<typeof ReportMetrics> {}

export const ReportRow = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  ...ReportMetricsFields,
})
  .check(costAndProvenanceTogether(11))
  .annotate({ identifier: "ProviderRequest.ReportRow" })
export interface ReportRow extends Schema.Schema.Type<typeof ReportRow> {}

export const Report = Schema.Struct({
  group: ReportGroup,
  rows: Schema.Array(ReportRow),
  total: ReportMetrics,
  /** Number of grouped rows before pagination. */
  rowCount: NonNegativeInt,
  nextOffset: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "ProviderRequest.Report" })
export interface Report extends Schema.Schema.Type<typeof Report> {}
