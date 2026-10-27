export * as Dots from "./dots.js"

import { Option, Schema } from "effect"
import { PromptInput } from "./prompt-input.js"
import { optional, PositiveInt } from "./schema.js"
import { SessionID } from "./session-id.js"
import { ID } from "./session-message-id.js"
import { McpEvents } from "./mcp-events.js"
import { Form } from "./form.js"
import { Guardrail } from "./guardrail.js"
import { Permission } from "./permission.js"
import { Question } from "./question.js"
import { SessionOrchestration } from "./session-orchestration.js"
import { SessionReview } from "./session-review.js"
import { Event } from "./event.js"

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
export const SessionDelegationScope = Schema.Struct({
  operations: Schema.NonEmptyArray(Schema.Literals(["task", "decision"])),
}).check(Schema.makeFilter((value) => new Set(value.operations).size === value.operations.length && value.operations.includes("task"), {
  expected: "distinct operations including task",
  meta: { _tag: "isMaxProperties", maxProperties: 1 },
  arbitrary: { constraint: { maxLength: 1 } },
})).annotate({ identifier: "Dots.SessionDelegationScope", parseOptions: { onExcessProperty: "error" } })
export type SessionDelegationScope = typeof SessionDelegationScope.Type
const DecisionFingerprint = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
export const DecisionTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("permission"), requestID: Permission.ID, fingerprint: DecisionFingerprint }),
  Schema.Struct({ kind: Schema.Literal("guardrail"), requestID: Guardrail.RequestID, fingerprint: DecisionFingerprint }),
  Schema.Struct({ kind: Schema.Literal("form"), formID: Form.ID, fingerprint: DecisionFingerprint }),
  Schema.Struct({ kind: Schema.Literal("question"), requestID: Question.ID, fingerprint: DecisionFingerprint }),
  Schema.Struct({ kind: Schema.Literal("subagent_question"), questionID: SessionOrchestration.QuestionID, fingerprint: DecisionFingerprint }),
  Schema.Struct({ kind: Schema.Literal("review"), itemID: SessionReview.ID, fingerprint: DecisionFingerprint }),
]).annotate({ identifier: "Dots.DecisionTarget", parseOptions: { onExcessProperty: "error" } })
export type DecisionTarget = typeof DecisionTarget.Type
const DelegatedReply = Schema.Literals(["once", "reject"])
export const ReviewDecision = Schema.Union([
  SessionReview.Decision.members[0],
  SessionReview.Decision.members[1],
  Schema.Struct({ ...SessionReview.Decision.members[2].fields, reply: DelegatedReply }),
  Schema.Struct({ ...SessionReview.Decision.members[3].fields, reply: DelegatedReply }),
  SessionReview.Decision.members[4],
  SessionReview.Decision.members[5],
]).annotate({ identifier: "Dots.ReviewDecision", parseOptions: { onExcessProperty: "error" } })
export type ReviewDecision = typeof ReviewDecision.Type
export const DelegatedInstruction = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("task"), text: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(32768)) }),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("permission"), requestID: Permission.ID, fingerprint: DecisionFingerprint }), reply: DelegatedReply }),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("guardrail"), requestID: Guardrail.RequestID, fingerprint: DecisionFingerprint }), reply: DelegatedReply }),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("form"), formID: Form.ID, fingerprint: DecisionFingerprint }), answers: Form.Answer }),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("question"), requestID: Question.ID, fingerprint: DecisionFingerprint }), answers: Schema.Array(Question.Answer) }),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("form"), formID: Form.ID, fingerprint: DecisionFingerprint }), cancelled: Schema.Literal(true) }),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("question"), requestID: Question.ID, fingerprint: DecisionFingerprint }), cancelled: Schema.Literal(true) }),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("subagent_question"), questionID: SessionOrchestration.QuestionID, fingerprint: DecisionFingerprint }), text: SessionOrchestration.ControlText.pipe(optional), data: SessionOrchestration.AnswerData.pipe(optional) }).check(Schema.makeFilter((value) => value.text !== undefined || value.data !== undefined, { expected: "text or data for the child question", meta: { _tag: "isMinProperties", minProperties: 3 }, arbitrary: { constraint: { minLength: 3 } } })),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("subagent_question"), questionID: SessionOrchestration.QuestionID, fingerprint: DecisionFingerprint }), dismissed: Schema.Literal(true) }),
  Schema.Struct({ operation: Schema.Literal("decision"), target: Schema.Struct({ kind: Schema.Literal("review"), itemID: SessionReview.ID, fingerprint: DecisionFingerprint }), decision: ReviewDecision }),
]).annotate({ identifier: "Dots.DelegatedInstruction", parseOptions: { onExcessProperty: "error" } })
export type DelegatedInstruction = typeof DelegatedInstruction.Type
export const DelegatedReceipt = Schema.Struct({ delegation: DelegationRef, instruction: DelegatedInstruction }).annotate({ identifier: "Dots.DelegatedReceipt" })
export type DelegatedReceipt = typeof DelegatedReceipt.Type
export const DecisionCandidate = Schema.Struct({
  target: DecisionTarget,
  action: Schema.String.check(Schema.isMaxLength(256)).pipe(optional),
  resources: Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).pipe(optional),
  ruleIDs: Schema.Array(Schema.String.check(Schema.isMaxLength(256))).pipe(optional),
  title: Schema.String.check(Schema.isMaxLength(256)).pipe(optional),
  fields: Form.Fields.pipe(optional),
  questions: Schema.Array(Question.Info).pipe(optional),
  subagentQuestion: SessionOrchestration.Question.pipe(optional),
  review: SessionReview.Item.pipe(optional),
}).annotate({ identifier: "Dots.DecisionCandidate" })
export type DecisionCandidate = typeof DecisionCandidate.Type
export const DecisionOutcome = Schema.Struct({
  target: DecisionTarget,
  state: Schema.Literals(["pending", "settled", "stale", "unknown"]),
  reply: DelegatedReply.pipe(optional),
}).annotate({ identifier: "Dots.DecisionOutcome" })
export type DecisionOutcome = typeof DecisionOutcome.Type
export const DeviceDelegationScope = Schema.Struct({
  target: Schema.Literal("device"),
  operations: Schema.NonEmptyArray(Schema.Literals(["task", "decision"])),
}).check(Schema.makeFilter((value) => new Set(value.operations).size === value.operations.length, {
  expected: "distinct delegated operations", meta: { _tag: "isMaxProperties", maxProperties: 2 }, arbitrary: { constraint: { maxLength: 2 } },
})).annotate({ identifier: "Dots.DeviceDelegationScope", parseOptions: { onExcessProperty: "error" } })
export type DeviceDelegationScope = typeof DeviceDelegationScope.Type
const DeviceIdentity = Identity.check(Schema.isMaxLength(256))
export const DeviceDelegationCreate = Schema.Struct({
  id: DeviceIdentity, exchangeID: DeviceIdentity, bindingID: DeviceIdentity, expectedAttachment: Target, scope: DeviceDelegationScope,
}).annotate({ identifier: "Dots.DeviceDelegationCreate", parseOptions: { onExcessProperty: "error" } })
export interface DeviceDelegationCreate extends Schema.Schema.Type<typeof DeviceDelegationCreate> {}
export const DeviceDelegationInfo = Schema.Struct({
  ...DelegationRef.fields, basis: Schema.Literal("device"), anchorSessionID: SessionID, bindingID: DeviceIdentity,
  principal: McpEvents.Principal, scope: DeviceDelegationScope, expiresAt: PositiveInt, active: Schema.Boolean,
}).annotate({ identifier: "Dots.DeviceDelegationInfo" })
export interface DeviceDelegationInfo extends Schema.Schema.Type<typeof DeviceDelegationInfo> {}
const PageFields = { cursor: Schema.String.check(Schema.isMaxLength(4096)).pipe(optional), limit: PositiveInt.check(Schema.isLessThanOrEqualTo(100)).pipe(optional) }
export const DeviceDelegationRead = Schema.Struct(PageFields).annotate({ identifier: "Dots.DeviceDelegationRead", parseOptions: { onExcessProperty: "error" } })
export interface DeviceDelegationRead extends Schema.Schema.Type<typeof DeviceDelegationRead> {}
export const DeviceDelegationStatus = Schema.Struct({
  binding: Schema.Struct({ id: DeviceIdentity, target: Target }), grants: Schema.Array(DeviceDelegationInfo), nextCursor: PageFields.cursor,
}).annotate({ identifier: "Dots.DeviceDelegationStatus" })
export interface DeviceDelegationStatus extends Schema.Schema.Type<typeof DeviceDelegationStatus> {}
export const DeviceDelegationRevoke = Schema.Struct({
  ...DelegationRef.fields, exchangeID: DeviceIdentity, bindingID: DeviceIdentity, expectedAttachment: Target,
}).annotate({ identifier: "Dots.DeviceDelegationRevoke", parseOptions: { onExcessProperty: "error" } })
export interface DeviceDelegationRevoke extends Schema.Schema.Type<typeof DeviceDelegationRevoke> {}
export const DecisionsList = Schema.Struct({
  bindingID: DeviceIdentity, expectedAttachment: Target, delegation: DelegationRef, targetSessionID: SessionID.pipe(optional), ...PageFields,
}).annotate({ identifier: "Dots.DecisionsList", parseOptions: { onExcessProperty: "error" } })
export interface DecisionsList extends Schema.Schema.Type<typeof DecisionsList> {}
export const DecisionsPage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ targetSessionID: SessionID, candidate: DecisionCandidate })), nextCursor: PageFields.cursor,
}).annotate({ identifier: "Dots.DecisionsPage" })
export interface DecisionsPage extends Schema.Schema.Type<typeof DecisionsPage> {}
export const BindingRecord = Schema.Struct({ id: DeviceIdentity, target: Target, accountDigest: Identity })
export interface BindingRecord extends Schema.Schema.Type<typeof BindingRecord> {}
const authorityEvent = { durable: { aggregate: "sessionID", version: 1 } } as const
export const BindingBound = Event.durable({
  type: "session.dots.binding.bound", ...authorityEvent, schema: { sessionID: SessionID, binding: BindingRecord },
})
export const BindingUnbound = Event.durable({
  type: "session.dots.binding.unbound", ...authorityEvent, schema: { sessionID: SessionID, bindingID: DeviceIdentity },
})
export const DeviceDelegationCreated = Event.durable({
  type: "session.dots.device-delegation.created", ...authorityEvent,
  schema: { sessionID: SessionID, exchangeID: DeviceIdentity, fingerprint: DecisionFingerprint, grant: DeviceDelegationInfo },
})
export const DeviceDelegationRevoked = Event.durable({
  type: "session.dots.device-delegation.revoked", ...authorityEvent,
  schema: { sessionID: SessionID, exchangeID: DeviceIdentity, fingerprint: DecisionFingerprint, delegationID: DeviceIdentity, revision: PositiveInt, principal: McpEvents.Principal },
})
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
  Schema.Struct({ ...exchangeFields, ...DelegatedReceipt.fields }).annotate({ parseOptions: { onExcessProperty: "error" } }),
]).annotate({ identifier: "Dots.ExchangeCreate" })
export type ExchangeCreate = typeof ExchangeCreate.Type

export const DelegationStatusInput = Schema.Struct({ expectedAttachment: Target, targetSessionID: SessionID }).annotate({ identifier: "Dots.DelegationStatusInput", parseOptions: { onExcessProperty: "error" } })
const RoutineDelegationCreate = Schema.Struct({ ...DelegationStatusInput.fields,
  proposalID: Identity.check(Schema.isMaxLength(256)), sourceExchangeID: exchangeFields.exchangeID,
  taskInputID: ID, scope: DelegationScope, expiresAt: PositiveInt,
}).annotate({ parseOptions: { onExcessProperty: "error" } })
export const SessionDelegationCreate = Schema.Struct({ ...DelegationStatusInput.fields,
  proposalID: Identity.check(Schema.isMaxLength(256)), sourceExchangeID: exchangeFields.exchangeID,
  basis: Schema.Literal("session"), taskInputID: Schema.Never.pipe(optional), scope: SessionDelegationScope, expiresAt: PositiveInt,
}).annotate({ identifier: "Dots.SessionDelegationCreate", parseOptions: { onExcessProperty: "error" } })
export type SessionDelegationCreate = typeof SessionDelegationCreate.Type
export const DelegationCreate = Schema.Union([RoutineDelegationCreate, SessionDelegationCreate]).annotate({ identifier: "Dots.DelegationCreate", parseOptions: { onExcessProperty: "error" } })
export type DelegationCreate = typeof DelegationCreate.Type
export const DelegationRevoke = Schema.Struct({ ...DelegationRef.fields, expectedAttachment: Target }).annotate({ identifier: "Dots.DelegationRevoke", parseOptions: { onExcessProperty: "error" } })
export type DelegationRevoke = typeof DelegationRevoke.Type
const RoutineDelegationInfo = Schema.Struct({ ...DelegationRef.fields,
  sourceExchangeID: exchangeFields.exchangeID, targetSessionID: SessionID, taskInputID: ID,
  principal: McpEvents.Principal, scope: DelegationScope, expiresAt: PositiveInt,
  active: Schema.Boolean,
})
export const SessionDelegationInfo = Schema.Struct({ ...DelegationRef.fields,
  sourceExchangeID: exchangeFields.exchangeID, targetSessionID: SessionID, basis: Schema.Literal("session"),
  principal: McpEvents.Principal, scope: SessionDelegationScope, expiresAt: PositiveInt,
  active: Schema.Boolean,
}).annotate({ identifier: "Dots.SessionDelegationInfo" })
export type SessionDelegationInfo = typeof SessionDelegationInfo.Type
export const DelegationInfo = Schema.Union([RoutineDelegationInfo, SessionDelegationInfo]).annotate({ identifier: "Dots.DelegationInfo" })
export type DelegationInfo = typeof DelegationInfo.Type
export const DelegationReview = Schema.Struct({
  kind: Schema.Literal("dots-task-delegation"), proposalID: RoutineDelegationCreate.fields.proposalID,
  sourceExchangeID: exchangeFields.exchangeID, principal: McpEvents.Principal,
  targetSessionID: SessionID, taskInputID: ID, task: Schema.String, expectedAttachment: Target,
  scope: DelegationScope, expiresAt: PositiveInt, lifetime: Schema.Literal("binding"), fingerprint: Identity,
}).annotate({ identifier: "Dots.DelegationReview" })
export type DelegationReview = typeof DelegationReview.Type
export const SessionDelegationReview = Schema.Struct({
  kind: Schema.Literal("dots-session-delegation"), proposalID: SessionDelegationCreate.fields.proposalID,
  sourceExchangeID: exchangeFields.exchangeID, principal: McpEvents.Principal,
  targetSessionID: SessionID, expectedAttachment: Target,
  scope: SessionDelegationScope, expiresAt: PositiveInt, lifetime: Schema.Literal("binding"), fingerprint: Identity,
}).annotate({ identifier: "Dots.SessionDelegationReview" })
export type SessionDelegationReview = typeof SessionDelegationReview.Type
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
  Schema.Struct({ state: Schema.Literal("enabled"), generation: PositiveInt, tool: Schema.Literal("dots_report"), envelope: TaskEnvelope, routine: RoutineReceipt.pipe(optional), delegated: DelegatedReceipt.pipe(optional) }),
  Schema.Struct({ state: Schema.Literal("disabled"), generation: PositiveInt, reason: Schema.Literals(["capability_disabled", "no_task", "task_settled", "unavailable", "tool_unavailable"]), routine: RoutineReceipt.pipe(optional), delegated: DelegatedReceipt.pipe(optional) }),
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
  delegated: DelegatedReceipt.pipe(optional),
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
  decisions: Schema.Array(DecisionCandidate).pipe(optional),
  decisionOutcome: DecisionOutcome.pipe(optional),
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
  delegated: DelegatedReceipt.pipe(optional),
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
const decodeDelegated = Schema.decodeUnknownOption(DelegatedReceipt)
export const routine = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const exchange = metadata?.dotsExchange
  if (typeof exchange !== "object" || exchange === null || !("routine" in exchange)) return undefined
  return Option.getOrUndefined(decodeRoutine(exchange.routine, { onExcessProperty: "error" }))
}

export const delegated = (metadata: Readonly<Record<string, unknown>> | undefined) => {
  const exchange = metadata?.dotsExchange
  if (typeof exchange !== "object" || exchange === null || !("delegated" in exchange)) return undefined
  return Option.getOrUndefined(decodeDelegated(exchange.delegated, { onExcessProperty: "error" }))
}

export const peer = (metadata: Readonly<Record<string, unknown>> | undefined) =>
  metadata === undefined ? undefined : Option.getOrUndefined(decodePeer(metadata.dots))
