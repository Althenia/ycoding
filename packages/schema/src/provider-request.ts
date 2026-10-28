export * as ProviderRequest from "./provider-request.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Model } from "./model.js"
import { Money } from "./money.js"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, PositiveInt } from "./schema.js"
import { SessionID } from "./session-id.js"
import { ID as SessionMessageID } from "./session-message-id.js"
import { TokenUsage } from "./token-usage.js"
import { Provider } from "./provider.js"
import { UsageAnchor } from "./usage-anchor.js"

export const ID = Schema.String.check(Schema.isStartsWith("prq_")).pipe(
  Schema.brand("ProviderRequest.ID"),
  Schema.annotate({ identifier: "ProviderRequest.ID" }),
)
export type ID = typeof ID.Type

export const Source = Schema.Literals(["step", "title", "goal", "compaction", "decision", "prediction", "prompt"])
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

export const ReportGroup = Schema.Literals(["model", "hour", "day", "month", "session", "project", "agent", "provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"])
export type ReportGroup = typeof ReportGroup.Type

export const CostCoverage = Schema.Struct({ pricedRequests: NonNegativeInt, unpricedRequests: NonNegativeInt })
  .annotate({ identifier: "ProviderRequest.CostCoverage" })
export interface CostCoverage extends Schema.Schema.Type<typeof CostCoverage> {}

const ProfileFields = {
  providerID: Provider.ID,
  profile: Model.ProfileName.pipe(optional),
  profileState: Schema.Literals(["recorded", "provider-default"]),
}
const profileMatches = Schema.makeFilter((value: { readonly profile?: string; readonly profileState: string }) =>
  (value.profileState === "recorded") === (value.profile !== undefined), {
  expected: "a recorded profile name or the provider default at request time",
  meta: { _tag: "isMaxProperties", maxProperties: 6 },
  arbitrary: { constraint: { maxLength: 6 } },
})

export const ReportDimensions = Schema.Union([
  Schema.Struct({ group: Schema.Literal("provider"), providerID: Provider.ID }),
  Schema.Struct({ group: Schema.Literal("provider-profile-model"), ...ProfileFields, modelID: Model.ID }).check(profileMatches),
  Schema.Struct({ group: Schema.Literal("provider-model"), providerID: Provider.ID, modelID: Model.ID }),
  Schema.Struct({ group: Schema.Literal("model-id"), modelID: Model.ID }),
  Schema.Struct({ group: Schema.Literal("profile"), ...ProfileFields }).check(profileMatches),
  Schema.Struct({ group: Schema.Literal("prompt"), anchor: UsageAnchor.Ref.pipe(optional), attribution: Schema.Literals(["complete", "partial", "unattributed"]) }),
  Schema.Struct({ group: Schema.Literal("task"), sessionID: SessionID.pipe(optional), attribution: Schema.Literals(["complete", "partial", "unattributed"]) }),
]).annotate({ identifier: "ProviderRequest.ReportDimensions" })
export type ReportDimensions = typeof ReportDimensions.Type

export const ReportSort = Schema.Literals(["key", "tokens", "cost", "steps", "input", "output", "reasoning", "cacheRead", "cacheWrite"])
export type ReportSort = typeof ReportSort.Type

export const ReportOrder = Schema.Literals(["asc", "desc"])
export type ReportOrder = typeof ReportOrder.Type

export const Timing = Schema.Struct({
  firstOutputMs: NonNegativeInt.pipe(optional),
  totalMs: NonNegativeInt.pipe(optional),
  retryWaitMs: NonNegativeInt.pipe(optional),
  promptEvalDurationNs: NonNegativeInt.pipe(optional),
  generationDurationNs: NonNegativeInt.pipe(optional),
  observedGenerationDurationNs: PositiveInt.pipe(optional),
  generatedTokens: PositiveInt.pipe(optional),
  estimatedTokens: PositiveInt.pipe(optional),
  estimatedGenerationDurationNs: PositiveInt.pipe(optional),
  receivedOutput: Schema.Struct({ estimatedTokens: PositiveInt, durationNs: PositiveInt }).pipe(optional),
  loadDurationNs: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "ProviderRequest.Timing" })
export interface Timing extends Schema.Schema.Type<typeof Timing> {}

export const Speed = Schema.Struct({
  generationSamples: NonNegativeInt,
  generationP50TokensPerSecond: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(optional),
  generationP90TokensPerSecond: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(optional),
  generationP95TokensPerSecond: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(optional),
  meanTokensPerSecond: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(optional),
  providerTimedSamples: NonNegativeInt,
  observedSamples: NonNegativeInt,
  firstOutputP50Ms: NonNegativeInt.pipe(optional),
  firstOutputP95Ms: NonNegativeInt.pipe(optional),
  firstOutputP99Ms: NonNegativeInt.pipe(optional),
  totalP50Ms: NonNegativeInt.pipe(optional),
  totalP95Ms: NonNegativeInt.pipe(optional),
  totalP99Ms: NonNegativeInt.pipe(optional),
  outputTokensPerSecond: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)).pipe(optional),
  samples: NonNegativeInt,
}).annotate({ identifier: "ProviderRequest.Speed" })
export interface Speed extends Schema.Schema.Type<typeof Speed> {}

const ReportLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(200))
const ReportTimeZone = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128))

export const ReportInput = Schema.Struct({
  group: ReportGroup,
  providerID: Provider.ID.pipe(optional),
  profile: Model.ProfileName.pipe(optional),
  modelID: Model.ID.pipe(optional),
  selectedEffort: Schema.String.check(Schema.isNonEmpty()).pipe(optional),
  timeZone: ReportTimeZone.pipe(optional),
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
      meta: { _tag: "isMaxProperties", maxProperties: 12 },
      arbitrary: { constraint: { maxLength: 12 } },
    }),
  )
  .annotate({ identifier: "ProviderRequest.ReportInput" })
export interface ReportInput extends Schema.Schema.Type<typeof ReportInput> {}

export const Outcome = Schema.Literals(["completed", "failed", "cancelled"])
export type Outcome = typeof Outcome.Type

export const Outcomes = Schema.Struct({
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  cancelled: NonNegativeInt,
}).annotate({ identifier: "ProviderRequest.Outcomes" })
export interface Outcomes extends Schema.Schema.Type<typeof Outcomes> {}

export const Record = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  inputID: SessionMessageID.pipe(optional),
  usageAnchor: UsageAnchor.Ref.pipe(optional),
  assistantMessageID: SessionMessageID.pipe(optional),
  connectionIdentityDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(optional),
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
  timing: Timing.pipe(optional),
  outcome: Outcome.pipe(optional),
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
  /** Absent when no request in the group has persisted or catalog-estimated cost. */
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
  latestTiming: Timing.pipe(optional),
}).annotate({ identifier: "ProviderRequest.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}

const ReportMetricsFields = {
  logical: NonNegativeInt,
  physical: NonNegativeInt,
  helpers: NonNegativeInt,
  continued: NonNegativeInt,
  fallback: NonNegativeInt,
  costCoverage: CostCoverage.pipe(optional),
  tokens: TokenUsage.Info,
  /** Absent when no contributing request has recorded or current-catalog-estimated cost. */
  cost: Money.USD.pipe(optional),
  /** Required exactly when cost is present. */
  costProvenance: CostProvenance.pipe(optional),
  /** True only when every contributing request explicitly reported cache-read usage. */
  cacheReadReported: Schema.Boolean.pipe(optional),
  outcomes: Outcomes.pipe(optional),
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
  .check(costAndProvenanceTogether(11))
  .annotate({ identifier: "ProviderRequest.ReportMetrics" })
export interface ReportMetrics extends Schema.Schema.Type<typeof ReportMetrics> {}

export const ReportRow = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  model: Model.Ref.pipe(optional),
  dimensions: ReportDimensions.pipe(optional),
  ...ReportMetricsFields,
  speed: Speed.pipe(optional),
  concurrency: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(optional),
})
  .check(costAndProvenanceTogether(17))
  .annotate({ identifier: "ProviderRequest.ReportRow" })
export interface ReportRow extends Schema.Schema.Type<typeof ReportRow> {}

export const Report = Schema.Struct({
  group: ReportGroup,
  rows: Schema.Array(ReportRow),
  total: ReportMetrics,
  /** Number of grouped rows before pagination. */
  rowCount: NonNegativeInt,
  nextOffset: NonNegativeInt.pipe(optional),
  speed: Speed.pipe(optional),
}).check(Schema.makeFilter((value) =>
  !["provider", "provider-profile-model", "provider-model", "model-id", "profile", "prompt", "task"].includes(value.group) ||
    value.rows.every((row) => row.dimensions?.group === value.group && row.model === undefined), {
  expected: "typed dimensions without a representative model in mixed groups",
  meta: { _tag: "isMaxProperties", maxProperties: 6 },
  arbitrary: { constraint: { maxLength: 6 } },
})).annotate({ identifier: "ProviderRequest.Report" })
export interface Report extends Schema.Schema.Type<typeof Report> {}
