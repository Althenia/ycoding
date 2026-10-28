export * as UsageDashboard from "./usage-dashboard.js"

import { Schema } from "effect"
import { ProviderRequest } from "./provider-request.js"
import { ProviderUsage } from "./provider-usage.js"
import { Model } from "./model.js"
import { NonNegativeInt, optional } from "./schema.js"
import { UsageForecast } from "./usage-forecast.js"

export const Input = Schema.Struct({
  daily: ProviderRequest.ReportInput.pipe(optional),
  monthly: ProviderRequest.ReportInput.pipe(optional),
  breakdown: ProviderRequest.ReportInput.pipe(optional),
  refresh: Schema.Boolean.pipe(optional),
}).annotate({ identifier: "UsageDashboard.Input" })
export interface Input extends Schema.Schema.Type<typeof Input> {}

export const Preparing = Schema.Struct({ status: Schema.Literal("preparing") }).annotate({
  identifier: "UsageDashboard.Preparing",
})
export interface Preparing extends Schema.Schema.Type<typeof Preparing> {}

export const Failed = Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }).annotate({
  identifier: "UsageDashboard.Error",
})
export interface Failed extends Schema.Schema.Type<typeof Failed> {}

export const QuotaPreparing = Schema.Struct({ status: Schema.Literal("preparing") }).annotate({
  identifier: "UsageDashboard.QuotaPreparing",
})
export interface QuotaPreparing extends Schema.Schema.Type<typeof QuotaPreparing> {}

export const QuotaReady = Schema.Struct({
  status: Schema.Literal("ready"),
  providers: Schema.Array(ProviderUsage.Snapshot),
  forecast: UsageForecast.Info,
}).annotate({ identifier: "UsageDashboard.QuotaReady" })
export interface QuotaReady extends Schema.Schema.Type<typeof QuotaReady> {}

export const QuotaFailed = Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }).annotate({
  identifier: "UsageDashboard.QuotaFailed",
})
export interface QuotaFailed extends Schema.Schema.Type<typeof QuotaFailed> {}

export const Quota = Schema.Union([QuotaPreparing, QuotaReady, QuotaFailed]).annotate({ identifier: "UsageDashboard.Quota" })
export type Quota = typeof Quota.Type

const LiveRate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const LiveModel = Schema.Struct({
  model: Model.Ref,
  active: NonNegativeInt,
  streaming: NonNegativeInt,
  outputTokensPerSecond: LiveRate.pipe(optional),
}).annotate({ identifier: "UsageDashboard.LiveModel" })
export interface LiveModel extends Schema.Schema.Type<typeof LiveModel> {}

export const LivePoint = Schema.Struct({
  at: NonNegativeInt,
  active: NonNegativeInt,
  outputTokensPerSecond: LiveRate.pipe(optional),
}).annotate({ identifier: "UsageDashboard.LivePoint" })
export interface LivePoint extends Schema.Schema.Type<typeof LivePoint> {}

export const Live = Schema.Struct({
  asOf: NonNegativeInt,
  active: NonNegativeInt,
  streaming: NonNegativeInt,
  outputTokensPerSecond: LiveRate.pipe(optional),
  models: Schema.Array(LiveModel).check(Schema.isMaxLength(50)),
  history: Schema.Array(LivePoint).check(Schema.isMaxLength(120)),
}).annotate({ identifier: "UsageDashboard.Live" })
export interface Live extends Schema.Schema.Type<typeof Live> {}

export const Ready = Schema.Struct({
  status: Schema.Literal("ready"),
  asOf: NonNegativeInt,
  revision: Schema.String,
  summary: ProviderRequest.Summary,
  quota: Quota,
  live: Live,
  daily: ProviderRequest.Report.pipe(optional),
  monthly: ProviderRequest.Report.pipe(optional),
  breakdown: ProviderRequest.Report.pipe(optional),
}).annotate({ identifier: "UsageDashboard.Ready" })
export interface Ready extends Schema.Schema.Type<typeof Ready> {}

export const Info = Schema.Union([Preparing, Failed, Ready]).annotate({ identifier: "UsageDashboard.Info" })
export type Info = typeof Info.Type
