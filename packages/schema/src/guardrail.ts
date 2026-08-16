export * as Guardrail from "./guardrail.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { NonNegativeInt, optional, statics } from "./schema.js"

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

export const RuleSource = Schema.Literals(["standard", "custom"]).annotate({
  identifier: "Guardrail.RuleSource",
})
export type RuleSource = typeof RuleSource.Type

export const RuleDecision = Schema.Literals(["allow", "ask", "deny"]).annotate({
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

export class Request extends Schema.Class<Request>("Guardrail.Request")({
  id: RequestID,
  rootSessionID: SessionID,
  sessionID: SessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  ruleIDs: Schema.Array(Schema.String),
  reason: Schema.String,
  standard: Schema.Boolean,
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
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
}) {}

const Asked = ephemeral({ type: "guardrail.asked", schema: Request.fields })
const Replied = ephemeral({
  type: "guardrail.replied",
  schema: {
    rootSessionID: SessionID,
    sessionID: SessionID,
    requestID: RequestID,
    reply: Reply,
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

export const Event = { Asked, Replied, Decided, Definitions: inventory(Asked, Replied, Decided) }
