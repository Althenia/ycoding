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

export const PresentationPreferences = Schema.Struct({
  format: Schema.Literals(["prose", "bullets"]).pipe(optional),
  detail: Schema.Literals(["concise", "standard", "detailed"]).pipe(optional),
}).check(Schema.makeFilter((value) => value.format !== undefined || value.detail !== undefined, {
  expected: "at least one presentation preference",
  meta: { _tag: "isMinProperties", minProperties: 1 },
  arbitrary: { constraint: { minLength: 1 } },
}))
export type PresentationPreferences = typeof PresentationPreferences.Type
export const RoutineInstruction = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("continue") }),
  Schema.Struct({ operation: Schema.Literal("presentation"), preferences: PresentationPreferences }),
]).annotate({ identifier: "Dots.RoutineInstruction", parseOptions: { onExcessProperty: "error" } })
export type RoutineInstruction = typeof RoutineInstruction.Type
export const DelegationRef = Schema.Struct({ id: Identity, revision: PositiveInt })
export type DelegationRef = typeof DelegationRef.Type
export const RoutineReceipt = Schema.Struct({ delegation: DelegationRef, taskInputID: ID, instruction: RoutineInstruction })
export type RoutineReceipt = typeof RoutineReceipt.Type
export const DelegationScope = Schema.Struct({
  operations: Schema.NonEmptyArray(Schema.Literals(["continue", "presentation"])),
  format: Schema.NonEmptyArray(Schema.Literals(["prose", "bullets"])).pipe(optional),
  detail: Schema.NonEmptyArray(Schema.Literals(["concise", "standard", "detailed"])).pipe(optional),
}).check(Schema.makeFilter((value) => new Set(value.operations).size === value.operations.length &&
  (value.operations.includes("presentation") ? value.format !== undefined || value.detail !== undefined : value.format === undefined && value.detail === undefined), {
  expected: "distinct operations and presentation values only with presentation admission",
  meta: { _tag: "isMaxProperties", maxProperties: 3 },
  arbitrary: { constraint: { maxLength: 3 } },
}))
export type DelegationScope = typeof DelegationScope.Type
const exchangeFields = {
  exchangeID: Identity.check(Schema.isMaxLength(256)),
  expectedAttachment: Target,
  targetSessionID: SessionID,
  channel: Schema.Literal("task"),
  delivery: Schema.Literals(["steer", "queue"]),
}
export const ExchangeCreate = Schema.Union([
  Schema.Struct({ ...exchangeFields, text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32768)),
    delegation: Schema.Never.pipe(optional), taskInputID: Schema.Never.pipe(optional), instruction: Schema.Never.pipe(optional) }),
  Schema.Struct({ ...exchangeFields, ...RoutineReceipt.fields }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]).annotate({ identifier: "Dots.ExchangeCreate" })
export type ExchangeCreate = typeof ExchangeCreate.Type

export const DelegationStatusInput = Schema.Struct({ expectedAttachment: Target, targetSessionID: SessionID }).annotate({ identifier: "Dots.DelegationStatusInput", parseOptions: { onExcessProperty: "error" } })
export const DelegationCreate = Schema.Struct({ ...DelegationStatusInput.fields,
  proposalID: Identity.check(Schema.isMaxLength(256)), sourceExchangeID: exchangeFields.exchangeID,
  taskInputID: ID, scope: DelegationScope, expiresAt: PositiveInt,
}).annotate({ identifier: "Dots.DelegationCreate", parseOptions: { onExcessProperty: "error" } })
export type DelegationCreate = typeof DelegationCreate.Type
export const DelegationRevoke = Schema.Struct({ ...DelegationRef.fields, expectedAttachment: Target }).annotate({ identifier: "Dots.DelegationRevoke", parseOptions: { onExcessProperty: "error" } })
export type DelegationRevoke = typeof DelegationRevoke.Type
export const DelegationInfo = Schema.Struct({ ...DelegationRef.fields,
  sourceExchangeID: exchangeFields.exchangeID, targetSessionID: SessionID, taskInputID: ID,
  principal: McpEvents.Principal, scope: DelegationScope, expiresAt: PositiveInt,
  active: Schema.Boolean,
}).annotate({ identifier: "Dots.DelegationInfo" })
export type DelegationInfo = typeof DelegationInfo.Type
export const DelegationReview = Schema.Struct({
  kind: Schema.Literal("dots-task-delegation"), proposalID: DelegationCreate.fields.proposalID,
  sourceExchangeID: exchangeFields.exchangeID, principal: McpEvents.Principal,
  targetSessionID: SessionID, taskInputID: ID, task: Schema.String, expectedAttachment: Target,
  scope: DelegationScope, expiresAt: PositiveInt, lifetime: Schema.Literal("binding"), fingerprint: Identity,
}).annotate({ identifier: "Dots.DelegationReview" })
export type DelegationReview = typeof DelegationReview.Type
export const DelegationStatus = Schema.Struct({
  sources: Schema.Array(Schema.Struct({ sourceExchangeID: exchangeFields.exchangeID, principal: McpEvents.Principal })),
  tasks: Schema.Array(Schema.Struct({ taskInputID: ID, text: Schema.String })),
  grants: Schema.Array(DelegationInfo),
}).annotate({ identifier: "Dots.DelegationStatus" })
export type DelegationStatus = typeof DelegationStatus.Type

export interface ExchangeRead extends Schema.Schema.Type<typeof ExchangeRead> {}
export const ExchangeRead = Schema.Struct({ exchangeID: exchangeFields.exchangeID }).annotate({ identifier: "Dots.ExchangeRead" })

const envelopeFields = {
  coordinator: McpEvents.RequestContext.fields.principal,
  scope: Schema.Struct({ epoch: Identity, grantID: Identity }),
  exchangeID: exchangeFields.exchangeID,
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
  Schema.Struct({ state: Schema.Literal("enabled"), generation: PositiveInt, tool: Schema.Literal("dots_report"), envelope: TaskEnvelope, routine: RoutineReceipt.pipe(optional) }),
  Schema.Struct({ state: Schema.Literal("disabled"), generation: PositiveInt, reason: Schema.Literals(["capability_disabled", "no_task", "task_settled", "unavailable", "tool_unavailable"]), routine: RoutineReceipt.pipe(optional) }),
]).annotate({ identifier: "Dots.CoordinationContext" })

export interface ExchangeMetadata extends Schema.Schema.Type<typeof ExchangeMetadata> {}
export const ExchangeMetadata = Schema.Struct({
  sessionID: SessionID,
  targetSessionID: SessionID,
  exchangeID: exchangeFields.exchangeID,
  attachment: Schema.Struct({
    ...Target.fields,
    label: Schema.String.check(Schema.isPattern(/\S/)),
  }),
  envelope: TaskEnvelope.pipe(optional),
  routine: RoutineReceipt.pipe(optional),
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
  exchangeID: exchangeFields.exchangeID,
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
  exchangeID: exchangeFields.exchangeID,
  sessionID: SessionID,
  targetSessionID: SessionID,
  inputID: ID,
  expectedAttachment: Target,
  accountDigest: Identity,
  fingerprint: Identity,
  source: McpEvents.RequestContext,
  grantID: Identity,
  routine: RoutineReceipt.pipe(optional),
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
const decodeRoutine = Schema.decodeUnknownOption(RoutineReceipt)
export const routine = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const exchange = metadata?.dotsExchange
  if (typeof exchange !== "object" || exchange === null || !("routine" in exchange)) return undefined
  return Option.getOrUndefined(decodeRoutine(exchange.routine, { onExcessProperty: "error" }))
}

export const peer = (metadata: Readonly<Record<string, unknown>> | undefined) =>
  metadata === undefined ? undefined : Option.getOrUndefined(decodePeer(metadata.dots))
