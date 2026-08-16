export * as SessionCompaction from "./session-compaction.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { NonNegativeInt, DateTimeUtcFromMillis, statics } from "./schema.js"
import { SessionID } from "./session-id.js"
import { ID as SessionMessageID } from "./session-message-id.js"

export const ID = Schema.String.check(Schema.isStartsWith("cmp_")).pipe(
  Schema.brand("SessionCompaction.ID"),
  statics((schema) => ({ create: () => schema.make("cmp_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Trigger = Schema.Literals(["consider", "advised", "mandatory", "manual"])
export type Trigger = typeof Trigger.Type

export const AdmissionMode = Schema.Literals(["background", "mandatory"])
export type AdmissionMode = typeof AdmissionMode.Type

export const FailureCode = Schema.Literals([
  "cancelled",
  "superseded",
  "invalid_manifest",
  "protected_state_changed",
  "context_limit_unresolved",
  "migration_failed",
  "provider_failed",
])
export type FailureCode = typeof FailureCode.Type

export interface Boundary extends Schema.Schema.Type<typeof Boundary> {}
export const Boundary = Schema.Struct({
  messageID: SessionMessageID,
  seq: NonNegativeInt,
}).annotate({ identifier: "SessionCompaction.Boundary" })

export interface Metrics extends Schema.Schema.Type<typeof Metrics> {}
export const Metrics = Schema.Struct({
  excludedMessages: NonNegativeInt,
  excludedParts: NonNegativeInt,
  inputTokens: NonNegativeInt,
  retainedTokens: NonNegativeInt,
}).annotate({ identifier: "SessionCompaction.Metrics" })

export interface Admission extends Schema.Schema.Type<typeof Admission> {}
export const Admission = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  trigger: Trigger,
  admissionMode: AdmissionMode,
  status: Schema.Literal("pending"),
  requestedThrough: Boundary,
  timeCreated: DateTimeUtcFromMillis,
}).annotate({ identifier: "SessionCompaction.Admission" })
