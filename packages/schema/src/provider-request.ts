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
  cost: Money.USD.pipe(optional),
  tokens: TokenUsage.Info,
  time: DateTimeUtcFromMillis,
}).annotate({ identifier: "ProviderRequest.Record" })
export interface Record extends Schema.Schema.Type<typeof Record> {}

export const Summary = Schema.Struct({
  logical: NonNegativeInt,
  physical: NonNegativeInt,
  helpers: NonNegativeInt,
  continued: NonNegativeInt,
  fallback: NonNegativeInt,
  cost: Money.USD.pipe(optional),
  tokens: TokenUsage.Info,
  latestInvalidation: Invalidation.pipe(optional),
  latestNamespace: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(8)).pipe(optional),
}).annotate({ identifier: "ProviderRequest.Summary" })
export interface Summary extends Schema.Schema.Type<typeof Summary> {}
