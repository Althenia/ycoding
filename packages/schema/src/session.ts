export * as Session from "./session.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Location } from "./location.js"
import { Model } from "./model.js"
import { Project } from "./project.js"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, RelativePath } from "./schema.js"
import { SessionEvent } from "./session-event.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"
import { Money } from "./money.js"
import { Permission } from "./permission.js"
import { TokenUsage } from "./token-usage.js"
import { Revert } from "./session-revert.js"
import { SessionCacheDiagnostics } from "./session-cache-diagnostics.js"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

export { Revert }

export const CacheMechanism = SessionCacheDiagnostics.Mechanism
export type CacheMechanism = SessionCacheDiagnostics.Mechanism

export const ProviderCacheDiagnostics = SessionCacheDiagnostics.ProviderCache
export type ProviderCacheDiagnostics = SessionCacheDiagnostics.ProviderCache

export const CacheDiagnostics = SessionCacheDiagnostics.Info
export type CacheDiagnostics = SessionCacheDiagnostics.Info

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  fork: Schema.Struct({
    sessionID: ID,
    /** Messages before this exclusive boundary are copied into the fork. */
    messageID: SessionMessage.ID.pipe(optional),
  }).pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  permissionCeiling: Permission.Ruleset.pipe(optional),
  cost: Money.USD,
  tokens: TokenUsage.Info,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
  }),
  title: Schema.String,
  location: Location.Ref,
  subpath: RelativePath.pipe(optional),
  revert: Revert.pipe(optional),
}).annotate({ identifier: "Session.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}

/**
 * Structured result returned when a model switch is refused because the current
 * context cannot fit the target model. `maximum_safe_summary_boundary` is an
 * advisory message ID: summarizing up to and including that message while
 * keeping `keep_recent_messages` after it is estimated to fit the target
 * budget, so the caller may offer summarization; it is omitted when no such
 * boundary exists.
 */
export const ModelSwitchBlocked = Schema.Struct({
  status: Schema.Literal("blocked"),
  currentModel: Model.Ref,
  targetModel: Model.Ref,
  currentContextTokens: NonNegativeInt,
  targetSafeInputTokens: NonNegativeInt,
  requiredReductionTokens: NonNegativeInt,
  maximumSafeSummaryBoundary: SessionMessage.ID.pipe(optional),
  reason: Schema.Literal("context-window-exceeded"),
}).annotate({ identifier: "Session.ModelSwitchBlocked" })
export interface ModelSwitchBlocked extends Schema.Schema.Type<typeof ModelSwitchBlocked> {}
