export * as Guardrail from "./guardrail.js"

import { Schema } from "effect"
import { Coordination } from "./coordination.js"
import { DecisionFailure } from "./decision-failure.js"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { SessionMessageID } from "./session-message-id.js"
import { NonNegativeInt, optional, statics } from "./schema.js"
import { SessionReviewID } from "./session-review-id.js"

const NonEmptyStrings = Schema.Array(Schema.String).check(
  Schema.makeFilter<ReadonlyArray<string>>((value) => value.length > 0, {
    expected: "a non-empty array of strings",
  }),
)

export const RequestID = Schema.String.check(Schema.isStartsWith("grq_")).pipe(
  Schema.brand("Guardrail.RequestID"),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "grq_" + ascending()) })),
)
export type RequestID = typeof RequestID.Type

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  messageID: SessionMessageID.ID,
  callID: Schema.String,
}).annotate({ identifier: "Guardrail.Source" })

export const DecisionChoice = Schema.Literals(["allow", "deny", "escalate", "approve_all", "approve", "reject"]).annotate({ identifier: "Guardrail.DecisionChoice" })
export type DecisionChoice = typeof DecisionChoice.Type

export const Authority = Schema.Literals(["baseline", "yolo"]).annotate({ identifier: "Guardrail.Authority" })
export type Authority = typeof Authority.Type

export interface Grade extends Schema.Schema.Type<typeof Grade> {}
export const Grade = Schema.Struct({
  choice: DecisionChoice,
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  evidence: Schema.String.check(Schema.isMaxLength(500), Schema.isPattern(/\S/)),
}).annotate({ identifier: "Guardrail.Grade" })

export interface Escalation extends Schema.Schema.Type<typeof Escalation> {}
export const EscalationReason = Schema.Union([
  DecisionFailure.Reason,
  Schema.Literals(["escalated", "low_confidence", "conflicting_grades"]),
]).annotate({ identifier: "Guardrail.EscalationReason" })
export type EscalationReason = typeof EscalationReason.Type

export const Escalation = Schema.Struct({
  authority: Authority.pipe(optional),
  reason: EscalationReason.pipe(optional),
  choice: DecisionChoice.pipe(optional),
  confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(optional),
  grades: Schema.Array(Grade).pipe(optional),
}).annotate({ identifier: "Guardrail.Escalation" })

export function escalationText(input: Escalation) {
  const authority = input.authority === "baseline" ? "Baseline assessment · " : input.authority === "yolo" ? "YOLO assessment · " : ""
  if (input.reason && Schema.is(DecisionFailure.Reason)(input.reason))
    return `${authority}Decision unavailable · ${DecisionFailure.describe(input.reason)} · Review this request manually${input.reason === "unsupported-output" ? ", or configure a decision helper on a supported strict structured-output route." : ". No automatic approval was granted."}`
  if (!input.reason && input.choice === undefined && input.confidence === undefined && !input.grades?.length)
    return `${authority}Decision unavailable · diagnostic reason was not recorded · Review this request manually.`
  const details = [
    ...(input.choice === undefined ? [] : [`choice ${input.choice}`]),
    ...(input.confidence === undefined ? [] : [`confidence ${input.confidence}`]),
  ]
  if (input.reason === "low_confidence")
    return `${authority}Decision requires human review · confidence below the approval threshold${details.length ? ` · ${details.join(" · ")}` : ""} · Review this request manually.`
  if (input.reason === "conflicting_grades")
    return `${authority}Decision requires human review · conflicting approval and rejection grades${details.length ? ` · ${details.join(" · ")}` : ""} · Review this request manually.`
  const outcome = input.choice === "escalate" ? "Decision model escalated this review" : "Decision requires human review"
  return `${authority}${outcome}${details.length ? ` · ${details.join(" · ")}` : ""} · Review this request manually.`
}

export const RuleSource = Schema.Literals(["standard", "custom"]).annotate({
  identifier: "Guardrail.RuleSource",
})
export type RuleSource = typeof RuleSource.Type

export const RuleDecision = Schema.Literals(["allow", "ask", "hard_review", "deny"]).annotate({
  identifier: "Guardrail.RuleDecision",
})
export type RuleDecision = typeof RuleDecision.Type

export const Decision = Schema.Literals(["allow", "ask", "deny", "cap_exceeded"]).annotate({
  identifier: "Guardrail.Decision",
})
export type Decision = typeof Decision.Type

export interface Rule extends Schema.Schema.Type<typeof Rule> {}
export const Rule = Schema.Struct({
  id: Schema.String.check(Schema.isNonEmpty()),
  source: RuleSource,
  decision: RuleDecision,
  actions: NonEmptyStrings,
  resources: NonEmptyStrings,
  reason: Schema.String.check(Schema.isNonEmpty()),
  priority: Schema.Int,
}).annotate({ identifier: "Guardrail.Rule" })

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "Guardrail.Ruleset" })
export type Ruleset = typeof Ruleset.Type

export interface Risk extends Schema.Schema.Type<typeof Risk> {}
export const Risk = Schema.Struct({
  level: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 })),
  label: Schema.String,
  score: Schema.Number.check(Schema.isFinite()),
  metric: Schema.Literals(["confidence", "probability"]),
}).annotate({ identifier: "Guardrail.Risk" })

export class Request extends Schema.Class<Request>("Guardrail.Request")({
  id: RequestID,
  rootSessionID: SessionID,
  sessionID: SessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  ruleIDs: Schema.Array(Schema.String),
  reason: Schema.String,
  standard: Schema.Boolean,
  hardReview: Schema.Boolean.pipe(optional),
  risk: Risk.pipe(optional),
  escalation: Escalation.pipe(optional),
  coordinationEscalation: Coordination.Escalation.pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
  source: Source.pipe(optional),
}) {}

export const Reply = Schema.Literals(["once", "always", "reject"]).annotate({ identifier: "Guardrail.Reply" })
export type Reply = typeof Reply.Type

export class Counter extends Schema.Class<Counter>("Guardrail.Counter")({
  id: Schema.String,
  current: NonNegativeInt,
  limit: NonNegativeInt,
  scope: Schema.Literals(["session", "family"]),
}) {}

export class Status extends Schema.Class<Status>("Guardrail.Status")({
  rootSessionID: SessionID,
  profile: Schema.String,
  customRules: NonNegativeInt,
  approvals: NonNegativeInt,
  blocked: NonNegativeInt,
  counters: Schema.Array(Counter),
  invalidFiles: Schema.Array(Schema.String),
  dismissals: Schema.Array(Schema.Struct({
    sessionID: SessionID,
    created: NonNegativeInt,
    eventID: Schema.String,
    ruleID: Schema.String,
    confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0.9, maximum: 1 })),
    source: Source.pipe(optional),
  })).pipe(optional),
  decisions: Schema.Array(
    Schema.Struct({
      sessionID: SessionID,
      created: NonNegativeInt,
      requestID: Schema.String,
      reply: Reply,
      authority: Authority.pipe(optional),
      choice: DecisionChoice.pipe(optional),
      confidence: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(optional),
      grades: Schema.Array(Grade).pipe(optional),
      ruleIDs: Schema.Array(Schema.String).pipe(optional),
      source: Source.pipe(optional),
    }),
  ).pipe(optional),
}) {}

const Asked = ephemeral({ type: "guardrail.asked", schema: Request.fields })
export const Confidence = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).annotate({
  identifier: "Guardrail.Confidence",
})
export type Confidence = typeof Confidence.Type
const Replied = ephemeral({
  type: "guardrail.replied",
  schema: {
    rootSessionID: SessionID,
    sessionID: SessionID,
    requestID: RequestID,
    reply: Reply,
    decidedBy: Schema.Literal("decision-model").pipe(optional),
    authority: Authority.pipe(optional),
    choice: DecisionChoice.pipe(optional),
    confidence: Confidence.pipe(optional),
    grades: Schema.Array(Grade).pipe(optional),
  },
})
const Decided = ephemeral({
  type: "guardrail.decided",
  schema: {
    rootSessionID: SessionID,
    sessionID: SessionID,
    action: Schema.String,
    ruleIDs: Schema.Array(Schema.String),
    decision: Decision,
  },
})

const Deferred = ephemeral({
  type: "guardrail.deferred",
  schema: { rootSessionID: SessionID, sessionID: SessionID, requestID: RequestID, itemID: SessionReviewID },
})
const Cancelled = ephemeral({ type: "guardrail.cancelled", schema: { rootSessionID: SessionID, sessionID: SessionID, requestID: RequestID } })
export const Event = { Asked, Replied, Decided, Deferred, Cancelled, Definitions: inventory(Asked, Replied, Decided, Deferred, Cancelled) }
