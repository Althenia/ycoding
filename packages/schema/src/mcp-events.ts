export * as McpEvents from "./mcp-events.js"

import { Effect, Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"

export const Names = [
  "session.guardrail.changed",
  "session.permission.changed",
  "session.question.changed",
  "session.form.changed",
  "session.progress",
  "session.completed",
  "session.error",
] as const

export const Name = Schema.Literals(Names).annotate({ identifier: "McpEvents.Name" })
export type Name = typeof Name.Type

export interface Arguments extends Schema.Schema.Type<typeof Arguments> {}
export const Arguments = Schema.Struct({
  session_id: SessionID,
  include_descendants: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
}).annotate({ identifier: "McpEvents.Arguments" })

const CallbackURL = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048)).annotate({
  identifier: "McpEvents.CallbackURL",
})

export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}
export const Delivery = Schema.Struct({
  mode: Schema.Literal("webhook"),
  url: CallbackURL,
  secret: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
}).annotate({ identifier: "McpEvents.Delivery" })

export interface UnsubscribeDelivery extends Schema.Schema.Type<typeof UnsubscribeDelivery> {}
export const UnsubscribeDelivery = Schema.Struct({
  mode: Schema.Literal("webhook"),
  url: CallbackURL,
}).annotate({ identifier: "McpEvents.UnsubscribeDelivery" })

export interface Subscribe extends Schema.Schema.Type<typeof Subscribe> {}
export const Subscribe = Schema.Struct({
  name: Name,
  arguments: Arguments,
  delivery: Delivery,
  cursor: optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(1024)))),
  ttlMs: optional(Schema.NullOr(NonNegativeInt)),
}).annotate({ identifier: "McpEvents.Subscribe" })

export interface Unsubscribe extends Schema.Schema.Type<typeof Unsubscribe> {}
export const Unsubscribe = Schema.Struct({
  name: Name,
  arguments: Arguments,
  delivery: UnsubscribeDelivery,
}).annotate({ identifier: "McpEvents.Unsubscribe" })

export interface Subscription extends Schema.Schema.Type<typeof Subscription> {}
export const Subscription = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.NullOr(Schema.String),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
}).annotate({ identifier: "McpEvents.Subscription" })

const ScopeID = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
const ClientID = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2048),
  Schema.isPattern(/^[^\r\n\0]+$/),
)

export interface RequestContext extends Schema.Schema.Type<typeof RequestContext> {}
export const RequestContext = Schema.Struct({
  requestID: ScopeID,
  principal: Schema.Struct({
    ownerID: ScopeID,
    deviceID: ScopeID,
    clientID: ClientID,
  }),
  epoch: ScopeID,
}).annotate({ identifier: "McpEvents.RequestContext" })

export interface Principal extends Schema.Schema.Type<typeof Principal> {}
export const Principal = Schema.Struct({
  ownerID: ScopeID,
  deviceID: ScopeID,
  clientID: ClientID,
  grantID: ScopeID,
  epoch: ScopeID,
}).annotate({ identifier: "McpEvents.Principal" })

export const FailureCategory = Schema.Literals([
  "invalid_params",
  "callback_endpoint",
  "unauthorized",
  "unavailable",
]).annotate({ identifier: "McpEvents.FailureCategory" })
export type FailureCategory = typeof FailureCategory.Type

export const FailureReason = Schema.Literals([
  "invalid_name",
  "invalid_arguments",
  "invalid_delivery",
  "invalid_secret",
  "invalid_ttl",
  "invalid_cursor",
  "session_not_found",
  "challenge_failed",
  "timeout",
  "endpoint_unreachable",
  "endpoint_rejected",
  "payload_too_large",
  "unauthorized_principal",
  "grant_expired",
  "grant_revoked",
  "principal_scope_mismatch",
  "authorization_unavailable",
  "secure_storage_unavailable",
  "service_unavailable",
]).annotate({ identifier: "McpEvents.FailureReason" })
export type FailureReason = typeof FailureReason.Type

export class Failure extends Schema.TaggedErrorClass<Failure>()("McpEvents.Failure", {
  category: FailureCategory,
  reason: FailureReason,
}) {
  override get message() {
    return `${this.category}: ${this.reason}`
  }
}

export const State = Schema.Literals([
  "pending",
  "resolved",
  "cancelled",
  "deferred",
  "started",
  "running",
  "completed",
  "failed",
  "interrupted",
]).annotate({ identifier: "McpEvents.State" })
export type State = typeof State.Type

const Identifier = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
)
const Category = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]{0,63}$/),
)

export interface EventData extends Schema.Schema.Type<typeof EventData> {}
export const EventData = Schema.Struct({
  session_id: SessionID,
  root_session_id: SessionID,
  state: State,
  request_id: optional(Identifier),
  item_id: optional(Identifier),
  task_id: optional(Identifier),
  category: optional(Category),
  reason: optional(Category),
}).annotate({ identifier: "McpEvents.EventData" })

export interface Payload extends Schema.Schema.Type<typeof Payload> {}
export const Payload = Schema.Struct({
  eventId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Name,
  timestamp: Schema.String,
  data: EventData,
  cursor: Schema.NullOr(Schema.String),
}).annotate({ identifier: "McpEvents.Payload" })

export const JsonSchemaObject = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "McpEvents.JsonSchemaObject",
})
export type JsonSchemaObject = typeof JsonSchemaObject.Type

export interface EventDefinition extends Schema.Schema.Type<typeof EventDefinition> {}
export const EventDefinition = Schema.Struct({
  name: Name,
  description: Schema.String,
  delivery: Schema.Array(Schema.Literal("webhook")),
  inputSchema: JsonSchemaObject,
  payloadSchema: JsonSchemaObject,
}).annotate({ identifier: "McpEvents.EventDefinition" })

const inputSchema: JsonSchemaObject = {
  type: "object",
  properties: {
    session_id: { type: "string" },
    include_descendants: { type: "boolean", default: false },
  },
  required: ["session_id"],
  additionalProperties: false,
}

const payloadSchema: JsonSchemaObject = {
  type: "object",
  properties: {
    session_id: { type: "string" },
    root_session_id: { type: "string" },
    state: { type: "string" },
    request_id: { type: "string" },
    item_id: { type: "string" },
    task_id: { type: "string" },
    category: { type: "string" },
    reason: { type: "string" },
  },
  required: ["session_id", "root_session_id", "state"],
  additionalProperties: false,
}

const descriptions: Record<Name, string> = {
  "session.guardrail.changed": "A guardrail review for the session needs attention or settled.",
  "session.permission.changed": "A permission request for the session needs attention or settled.",
  "session.question.changed": "A question for the session needs attention or settled.",
  "session.form.changed": "A form for the session needs attention or settled.",
  "session.progress": "Execution or task state for the session changed materially.",
  "session.completed": "Work for the session completed.",
  "session.error": "Execution or a task for the session failed.",
}

export const Definitions: ReadonlyArray<EventDefinition> = Names.map((name) => ({
  name,
  description: descriptions[name],
  delivery: ["webhook"],
  inputSchema,
  payloadSchema,
}))

export interface ListResult extends Schema.Schema.Type<typeof ListResult> {}
export const ListResult = Schema.Struct({
  events: Schema.Array(EventDefinition),
}).annotate({ identifier: "McpEvents.ListResult" })
