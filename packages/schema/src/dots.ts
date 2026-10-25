export * as Dots from "./dots.js"

import { Option, Schema } from "effect"
import { PromptInput } from "./prompt-input.js"
import { optional, PositiveInt } from "./schema.js"
import { SessionID } from "./session-id.js"
import { ID } from "./session-message-id.js"
import { McpEvents } from "./mcp-events.js"

const Identity = Schema.String.check(Schema.isNonEmpty())

export interface Target extends Schema.Schema.Type<typeof Target> {}
export const Target = Schema.Struct({
  profile: Identity,
  dotID: Identity,
  threadID: Identity,
  generation: Identity,
  label: Schema.String,
}).annotate({ identifier: "Dots.Target" })

export const State = Schema.Literals(["disconnected", "connecting", "connected", "failed"]).annotate({
  identifier: "Dots.State",
})
export type State = typeof State.Type

export const RuntimeState = Schema.Literals(["paused", "unpaused", "unknown"]).annotate({
  identifier: "Dots.RuntimeState",
})
export type RuntimeState = typeof RuntimeState.Type

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  target: Target.pipe(optional),
  state: State,
  error: Schema.String.pipe(optional),
  runtimeState: RuntimeState.pipe(optional),
}).annotate({ identifier: "Dots.Status" })

export interface Control extends Schema.Schema.Type<typeof Control> {}
export const Control = Schema.Struct({
  expectedTarget: Target,
}).annotate({ identifier: "Dots.Control" })

export interface Send extends Schema.Schema.Type<typeof Send> {}
export const Send = Schema.Struct({
  id: Identity,
  text: Schema.String,
  files: Schema.Array(PromptInput.FileAttachment).pipe(optional),
  causalMessageID: Identity.pipe(optional),
  expectedTarget: Target,
}).annotate({ identifier: "Dots.Send" })

export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}
export const Delivery = Schema.Struct({
  messageID: Identity,
  status: Schema.Literals(["accepted", "unknown"]),
  turnID: Identity.pipe(optional),
}).annotate({ identifier: "Dots.Delivery" })

export interface ExchangeCreate extends Schema.Schema.Type<typeof ExchangeCreate> {}
export const ExchangeCreate = Schema.Struct({
  exchangeID: Identity.check(Schema.isMaxLength(256)),
  expectedAttachment: Target,
  targetSessionID: SessionID,
  channel: Schema.Literal("task"),
  delivery: Schema.Literals(["steer", "queue"]),
  text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32768)),
}).annotate({ identifier: "Dots.ExchangeCreate" })

export interface ExchangeRead extends Schema.Schema.Type<typeof ExchangeRead> {}
export const ExchangeRead = Schema.Struct({ exchangeID: ExchangeCreate.fields.exchangeID }).annotate({ identifier: "Dots.ExchangeRead" })

const envelopeFields = {
  coordinator: McpEvents.RequestContext.fields.principal,
  scope: Schema.Struct({ epoch: Identity, grantID: Identity }),
  exchangeID: ExchangeCreate.fields.exchangeID,
  messageID: ID,
}

export interface TaskEnvelope extends Schema.Schema.Type<typeof TaskEnvelope> {}
export const TaskEnvelope = Schema.Struct({
  ...envelopeFields,
  kind: Schema.Literal("task"),
  origin: Schema.Literal("plugin"),
  targetSessionID: SessionID,
}).annotate({ identifier: "Dots.TaskEnvelope" })

export interface ReportEnvelope extends Schema.Schema.Type<typeof ReportEnvelope> {}
export const ReportEnvelope = Schema.Struct({
  ...envelopeFields,
  kind: Schema.Literals(["progress", "blocker", "decision_request", "completion"]),
  origin: Schema.Literal("agent"),
  sourceSessionID: SessionID,
  replyToMessageID: ID,
}).annotate({ identifier: "Dots.ReportEnvelope" })

export type Envelope = TaskEnvelope | ReportEnvelope
export const Envelope = Schema.Union([TaskEnvelope, ReportEnvelope])

export type CoordinationContext = typeof CoordinationContext.Type
export const CoordinationContext = Schema.Union([
  Schema.Struct({ state: Schema.Literal("enabled"), generation: PositiveInt, tool: Schema.Literal("dots_report"), envelope: TaskEnvelope }),
  Schema.Struct({ state: Schema.Literal("disabled"), generation: PositiveInt, reason: Schema.Literals(["capability_disabled", "no_task", "task_settled", "unavailable", "tool_unavailable"]) }),
]).annotate({ identifier: "Dots.CoordinationContext" })

export interface ExchangeMetadata extends Schema.Schema.Type<typeof ExchangeMetadata> {}
export const ExchangeMetadata = Schema.Struct({
  sessionID: SessionID,
  targetSessionID: SessionID,
  exchangeID: ExchangeCreate.fields.exchangeID,
  attachment: Schema.Struct({
    ...Target.fields,
    label: Schema.String.check(Schema.isPattern(/\S/)),
  }),
  envelope: TaskEnvelope.pipe(optional),
}).annotate({ identifier: "Dots.ExchangeMetadata" })

export interface ExchangeOutput extends Schema.Schema.Type<typeof ExchangeOutput> {}
export const ExchangeOutput = Schema.Struct({
  deliveryID: Identity,
  messageID: ID,
  text: Schema.String,
  envelope: ReportEnvelope,
}).annotate({ identifier: "Dots.ExchangeOutput" })

export interface Exchange extends Schema.Schema.Type<typeof Exchange> {}
export const Exchange = Schema.Struct({
  envelope: TaskEnvelope,
  exchangeID: ExchangeCreate.fields.exchangeID,
  sessionID: SessionID,
  targetSessionID: SessionID,
  inputID: ID,
  channel: Schema.Literal("task"),
  state: Schema.Literals(["pending", "running", "completed", "failed", "unknown"]),
  progress: Schema.Array(ExchangeOutput),
  result: ExchangeOutput.pipe(optional),
}).annotate({ identifier: "Dots.Exchange" })

export interface ExchangeRecord extends Schema.Schema.Type<typeof ExchangeRecord> {}
export const ExchangeRecord = Schema.Struct({
  exchangeID: ExchangeCreate.fields.exchangeID,
  sessionID: SessionID,
  targetSessionID: SessionID,
  inputID: ID,
  expectedAttachment: Target,
  accountDigest: Identity,
  fingerprint: Identity,
  source: McpEvents.RequestContext,
  grantID: Identity,
  scope: Schema.Struct({ rootSessionID: SessionID, groupID: Identity.pipe(optional), ownerSessionID: SessionID.pipe(optional) }),
}).annotate({ identifier: "Dots.ExchangeRecord" })

export const ErrorCode = Schema.Literals([
  "feature_disabled",
  "invalid_input",
  "session_not_found",
  "profile_unavailable",
  "profile_changed",
  "authentication_failed",
  "target_unavailable",
  "target_in_use",
  "target_changed",
  "not_bound",
  "connection_unavailable",
  "attachment_invalid",
  "send_failed",
  "runtime_unknown",
  "control_failed",
  "exchange_conflict",
  "exchange_not_found",
  "target_forbidden",
  "authorization_failed",
  "exchange_outcome_unknown",
]).annotate({ identifier: "Dots.ErrorCode" })
export type ErrorCode = typeof ErrorCode.Type

export interface Peer extends Schema.Schema.Type<typeof Peer> {}
export const Peer = Schema.Struct({
  origin: Schema.Literal("dots-peer"),
  profile: Identity,
  dotID: Identity,
  threadID: Identity,
  turnID: Identity.pipe(optional),
  itemID: Identity,
  causalMessageID: Identity.pipe(optional),
}).annotate({ identifier: "Dots.Peer" })

const decodePeer = Schema.decodeUnknownOption(Peer)

export const peer = (metadata: Readonly<Record<string, unknown>> | undefined) =>
  metadata === undefined ? undefined : Option.getOrUndefined(decodePeer(metadata.dots))
