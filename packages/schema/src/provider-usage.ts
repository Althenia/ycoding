export * as ProviderUsage from "./provider-usage.js"

import { Schema } from "effect"
import { Provider } from "./provider.js"
import { NonNegativeInt, optional } from "./schema.js"

const NonNegativeFinite = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

export const Status = Schema.Literals(["available", "stale", "unsupported", "unauthorized", "error"]).annotate({
  identifier: "ProviderUsage.Status",
})
export type Status = typeof Status.Type

export const Source = Schema.Literals([
  "provider_api",
  "local_client_rpc",
  "response_headers",
  "provider_internal_api",
  "local_session",
]).annotate({ identifier: "ProviderUsage.Source" })
export type Source = typeof Source.Type

export const Stability = Schema.Literals(["stable", "client_contract", "observed", "best_effort"]).annotate({
  identifier: "ProviderUsage.Stability",
})
export type Stability = typeof Stability.Type

export const Unit = Schema.Literals(["percent", "usd", "requests", "tokens", "count"]).annotate({
  identifier: "ProviderUsage.Unit",
})
export type Unit = typeof Unit.Type

export class Window extends Schema.Class<Window>("ProviderUsage.Window")({
  id: Schema.String.check(Schema.isNonEmpty()),
  label: Schema.String.check(Schema.isNonEmpty()),
  unit: Unit,
  used: NonNegativeFinite.pipe(optional),
  limit: NonNegativeFinite.pipe(optional),
  remaining: NonNegativeFinite.pipe(optional),
  unlimited: Schema.Boolean.pipe(optional),
  resetAt: NonNegativeInt.pipe(optional),
  periodSeconds: NonNegativeInt.pipe(optional),
}) {}

export class Snapshot extends Schema.Class<Snapshot>("ProviderUsage.Snapshot")({
  providerID: Provider.ID,
  label: Schema.String.check(Schema.isNonEmpty()),
  status: Status,
  source: Source,
  stability: Stability,
  updatedAt: NonNegativeInt,
  windows: Schema.Array(Window),
  message: Schema.String.pipe(optional),
}) {}

export class Observation extends Schema.Class<Observation>("ProviderUsage.Observation")({
  providerID: Provider.ID,
  label: Schema.String.check(Schema.isNonEmpty()),
  source: Source,
  stability: Stability,
  observedAt: NonNegativeInt,
  windows: Schema.Array(Window),
}) {}
