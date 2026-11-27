export * as Recall from "./recall.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionMessage } from "./session-message.js"

export const CueKind = Schema.Literals([
  "explicit",
  "command",
  "path",
  "symbol",
  "tool_call",
  "tool_result",
  "tool_error",
  "workspace",
  "lifecycle",
  "compaction",
  "recovery",
  "memory_revision",
  "skill_revision",
]).annotate({ identifier: "Recall.CueKind" })
export type CueKind = typeof CueKind.Type

export const Trigger = Schema.Literals(["prompt", "cue", "explicit", "compaction", "recovery", "delegation"]).annotate({
  identifier: "Recall.Trigger",
})
export type Trigger = typeof Trigger.Type

export const Kind = Schema.Literals(["memory", "skill"]).annotate({ identifier: "Recall.Kind" })
export type Kind = typeof Kind.Type

export const Method = Schema.Literals(["explicit", "cue", "exact", "bm25", "semantic", "rrf"]).annotate({
  identifier: "Recall.Method",
})
export type Method = typeof Method.Type

/**
 * Furthest stage one item reached in a pass. `candidate` was retrieved but not chosen, `rejected` was
 * filtered with a reason, `selected` was chosen, `injected` entered the model request, and `restored`
 * re-entered it after compaction, recovery or delegation.
 */
export const Stage = Schema.Literals(["candidate", "rejected", "selected", "injected", "restored"]).annotate({
  identifier: "Recall.Stage",
})
export type Stage = typeof Stage.Type

export const Rejection = Schema.Literals([
  "denied",
  "disabled",
  "stale",
  "out_of_scope",
  "over_budget",
  "duplicate",
  "conflict",
  "below_threshold",
  "manual_only",
  "missing",
  "untrusted",
]).annotate({ identifier: "Recall.Rejection" })
export type Rejection = typeof Rejection.Type

export const Abstention = Schema.Literals([
  "no_match",
  "below_threshold",
  "explicit_unavailable",
  "out_of_budget",
  "offline",
]).annotate({ identifier: "Recall.Abstention" })
export type Abstention = typeof Abstention.Type

export const Outcome = Schema.Literals(["injected", "abstained", "restored"]).annotate({ identifier: "Recall.Outcome" })
export type Outcome = typeof Outcome.Type

export const Trust = Schema.Literals(["trusted", "unverified"]).annotate({ identifier: "Recall.Trust" })
export const Freshness = Schema.Literals(["fresh", "stale", "unknown"]).annotate({ identifier: "Recall.Freshness" })
export const Lifecycle = Schema.Literals(["active", "draft", "deprecated", "superseded", "archived", "unknown"]).annotate({
  identifier: "Recall.Lifecycle",
})

export const Scores = Schema.Struct({
  bm25: Schema.Finite.pipe(optional),
  semantic: Schema.Finite.pipe(optional),
  rrf: Schema.Finite.pipe(optional),
  rank: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Recall.Scores" })
export type Scores = typeof Scores.Type

export const Source = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
  revision: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
}).annotate({ identifier: "Recall.Source" })
export type Source = typeof Source.Type

export const Okf = Schema.Struct({
  type: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(128)),
  trust: Trust,
  freshness: Freshness,
  lifecycle: Lifecycle,
}).annotate({ identifier: "Recall.Okf" })
export type Okf = typeof Okf.Type

export const Item = Schema.Struct({
  kind: Kind,
  id: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  stage: Stage,
  method: Method,
  scores: Scores.pipe(optional),
  reason: Schema.String.check(Schema.isMaxLength(200)),
  rejection: Rejection.pipe(optional),
  source: Source,
  okf: Okf.pipe(optional),
  artifact: SessionMessage.ArtifactProvenance.pipe(optional),
  tokens: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "Recall.Item" })
export type Item = typeof Item.Type

export const Items = Schema.Array(Item).check(Schema.isMaxLength(64)).annotate({ identifier: "Recall.Items" })
