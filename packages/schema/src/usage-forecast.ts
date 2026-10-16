export * as UsageForecast from "./usage-forecast.js"

import { Schema } from "effect"
import { Model } from "./model.js"
import { Money } from "./money.js"
import { Provider } from "./provider.js"
import { ProviderRequest } from "./provider-request.js"
import { ProviderUsage } from "./provider-usage.js"
import { NonNegativeInt, optional } from "./schema.js"

const Rate = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const LocalScope = Schema.Literals(["backend", "location"])
export type LocalScope = typeof LocalScope.Type
export const Input = Schema.Struct({ localScope: LocalScope }).annotate({ identifier: "UsageForecast.Input" })
export interface Input extends Schema.Schema.Type<typeof Input> {}

export const LocalRate = Schema.Struct({
  providerID: Provider.ID,
  profile: Model.ProfileName.pipe(optional),
  modelID: Model.ID.pipe(optional),
  observedFrom: NonNegativeInt,
  observedTo: NonNegativeInt,
  tokensPerMinute: Rate,
  tokensPerMinute5: Rate.pipe(optional),
  tokensPerMinute60: Rate.pipe(optional),
  estimatedUSDPerHour: Money.USD.pipe(optional),
  coverage: ProviderRequest.CostCoverage,
}).annotate({ identifier: "UsageForecast.LocalRate" })
export interface LocalRate extends Schema.Schema.Type<typeof LocalRate> {}

export const Quota = Schema.Struct({
  providerID: Provider.ID,
  profile: Model.ProfileName.pipe(optional),
  windowID: Schema.String,
  unit: ProviderUsage.Unit,
  source: ProviderUsage.Source,
  stability: ProviderUsage.Stability,
  updatedAt: NonNegativeInt,
  state: Schema.Literals(["estimated", "insufficient", "exhausted", "unlimited"]),
  method: Schema.Literals(["quota-delta-ema", "window-mean"]).pipe(optional),
  evidence: Schema.Literals(["low", "medium", "insufficient"]),
  reason: Schema.String.pipe(optional),
  observedFrom: NonNegativeInt.pipe(optional),
  observedTo: NonNegativeInt.pipe(optional),
  ratePerHour: Rate.pipe(optional),
  exhaustionAt: NonNegativeInt.pipe(optional),
  projectedUsedAtReset: Rate.pipe(optional),
}).annotate({ identifier: "UsageForecast.Quota" })
export interface Quota extends Schema.Schema.Type<typeof Quota> {}

export const Info = Schema.Struct({
  asOf: NonNegativeInt,
  localScope: LocalScope,
  localRates: Schema.Array(LocalRate).pipe(optional),
  quotas: Schema.Array(Quota).pipe(optional),
}).annotate({ identifier: "UsageForecast.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
