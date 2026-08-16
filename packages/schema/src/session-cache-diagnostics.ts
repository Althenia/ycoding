export * as SessionCacheDiagnostics from "./session-cache-diagnostics.js"

import { Schema } from "effect"
import { Model } from "./model.js"
import { Money } from "./money.js"
import { NonNegativeInt, optional } from "./schema.js"
import { ProviderRequest } from "./provider-request.js"

export const Mechanism = Schema.Literals([
  "openai-prefix-cache",
  "openrouter-cache-control",
  "anthropic-cache-control",
  "bedrock-cache-point",
  "gemini-prefix-cache",
  "provider-reported",
  "none",
]).annotate({ identifier: "Session.CacheMechanism" })
export type Mechanism = typeof Mechanism.Type

export const ProviderCache = Schema.Struct({
  mechanism: Mechanism,
  readReported: Schema.Boolean,
  writeReported: Schema.Boolean,
}).annotate({ identifier: "Session.ProviderCacheDiagnostics" })
export interface ProviderCache extends Schema.Schema.Type<typeof ProviderCache> {}

export const Info = Schema.Struct({
  model: Model.Ref,
  context: Schema.Struct({
    total: NonNegativeInt,
    limit: NonNegativeInt.pipe(optional),
    remaining: NonNegativeInt.pipe(optional),
    percent: Schema.Finite.pipe(optional),
  }),
  tokens: Schema.Struct({
    uncachedInput: NonNegativeInt,
    output: NonNegativeInt,
    reasoning: NonNegativeInt,
    cacheRead: NonNegativeInt,
    cacheWrite: NonNegativeInt,
  }),
  cache: Schema.Struct({
    eligible: NonNegativeInt,
    hitRatio: Schema.Finite.pipe(optional),
    mechanism: Mechanism,
    readReported: Schema.Boolean,
    writeReported: Schema.Boolean,
    /** Shortest prefix this model will cache. Absent when no profile is published. */
    minimumTokens: NonNegativeInt.pipe(optional),
    /**
     * True when the cacheable prefix is shorter than `minimumTokens`. The
     * provider accepts the breakpoints and then ignores them, so a 0% hit ratio
     * is expected rather than a fault.
     */
    belowMinimum: Schema.Boolean.pipe(optional),
  }),
  estimatedCost: Money.USD.pipe(optional),
  requests: ProviderRequest.Summary.pipe(optional),
}).annotate({ identifier: "Session.CacheDiagnostics" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
