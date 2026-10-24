export * as SessionReview from "./session-review.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Coordination } from "./coordination.js"
import { DecisionFailure } from "./decision-failure.js"
import { Form } from "./form.js"
import { Guardrail } from "./guardrail.js"
import { Permission } from "./permission.js"
import { Question } from "./question.js"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"
import { SessionOrchestration } from "./session-orchestration.js"
import { SessionReviewID } from "./session-review-id.js"

export const ID = SessionReviewID
export type ID = typeof ID.Type

export const Kind = Schema.Literals(["question", "subagent_question", "guardrail", "permission", "recovery"]).annotate({
  identifier: "SessionReview.Kind",
})
export type Kind = typeof Kind.Type

export const Reason = Schema.Union([
  DecisionFailure.Reason,
  Schema.Literals(["disabled", "free_text", "low_confidence", "escalated", "conflicting_grades", "error", "sleep_entry", "restart"]),
]).annotate({ identifier: "SessionReview.Reason" })
export type Reason = typeof Reason.Type

export const Origin = Schema.Union([
  Schema.Struct({ messageID: SessionMessage.ID, callID: Schema.String }),
  Schema.Struct({ questionID: SessionOrchestration.QuestionID }),
  Schema.Struct({ requestID: Schema.String.check(Schema.isNonEmpty()) }),
]).annotate({ identifier: "SessionReview.Origin" })
export type Origin = typeof Origin.Type

export const Fingerprint = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).annotate({
  identifier: "SessionReview.Fingerprint",
})
export type Fingerprint = typeof Fingerprint.Type

export const FormPayload = Schema.Struct({
  type: Schema.Literal("form"),
  title: Schema.String,
  fields: Form.Fields,
  questionTool: Schema.Literal(true).pipe(optional),
  coordinationEscalation: Coordination.Escalation.pipe(optional),
}).annotate({ identifier: "SessionReview.FormPayload" })
export interface FormPayload extends Schema.Schema.Type<typeof FormPayload> {}

export const QuestionPayload = Schema.Struct({
  type: Schema.Literal("question"),
  questions: Schema.Array(Question.Info),
}).annotate({ identifier: "SessionReview.QuestionPayload" })
export interface QuestionPayload extends Schema.Schema.Type<typeof QuestionPayload> {}

export const SubagentQuestionPayload = Schema.Struct({
  type: Schema.Literal("subagent_question"),
  text: SessionOrchestration.QuestionText,
  data: SessionOrchestration.AnswerData.pipe(optional),
}).annotate({ identifier: "SessionReview.SubagentQuestionPayload" })
export interface SubagentQuestionPayload extends Schema.Schema.Type<typeof SubagentQuestionPayload> {}

export const GuardrailPayload = Schema.Struct({
  type: Schema.Literal("guardrail"),
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  ruleIDs: Schema.Array(Schema.String),
  reason: Schema.String,
  hardReview: Schema.Boolean,
  directories: Schema.Array(Schema.String),
  fingerprint: Fingerprint,
  requestID: Guardrail.RequestID,
  coordinationEscalation: Coordination.Escalation.pipe(optional),
}).annotate({ identifier: "SessionReview.GuardrailPayload" })
export interface GuardrailPayload extends Schema.Schema.Type<typeof GuardrailPayload> {}

export const PermissionPayload = Schema.Struct({
  type: Schema.Literal("permission"),
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  save: Schema.Array(Schema.String).pipe(optional),
  fingerprint: Fingerprint,
  requestID: Permission.ID,
  coordinationEscalation: Coordination.Escalation.pipe(optional),
}).annotate({ identifier: "SessionReview.PermissionPayload" })
export interface PermissionPayload extends Schema.Schema.Type<typeof PermissionPayload> {}

export const RecoveryTool = Schema.Struct({
  messageID: SessionMessage.ID,
  callID: Schema.String,
  name: Schema.String,
}).annotate({ identifier: "SessionReview.RecoveryTool" })
export interface RecoveryTool extends Schema.Schema.Type<typeof RecoveryTool> {}

export const RecoveryPayload = Schema.Struct({
  type: Schema.Literal("recovery"),
  tools: Schema.Array(RecoveryTool).check(Schema.isMinLength(1)),
}).annotate({ identifier: "SessionReview.RecoveryPayload" })
export interface RecoveryPayload extends Schema.Schema.Type<typeof RecoveryPayload> {}

export const Payload = Schema.Union([
  FormPayload,
  QuestionPayload,
  SubagentQuestionPayload,
  GuardrailPayload,
  PermissionPayload,
  RecoveryPayload,
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "SessionReview.Payload" })
export type Payload = typeof Payload.Type

export const Deferral = Schema.Struct({
  itemID: ID,
  kind: Kind,
  reason: Reason,
  choice: Schema.String.pipe(optional),
  confidence: Guardrail.Confidence.pipe(optional),
  grades: Schema.Array(Guardrail.Grade).pipe(optional),
  origin: Origin,
  payload: Payload,
}).annotate({ identifier: "SessionReview.Deferral" })
export interface Deferral extends Schema.Schema.Type<typeof Deferral> {}

const ItemBase = {
  ...Deferral.fields,
  sessionID: SessionID,
  rootSessionID: SessionID,
  sessionTitle: Schema.String,
  created: NonNegativeInt,
  child: Schema.Struct({ agent: Agent.ID, description: SessionOrchestration.DescriptionText }).pipe(optional),
}

export const Item = Schema.Union([
  Schema.Struct({
    ...ItemBase,
    kind: Schema.Literal("question"),
    payload: Schema.Union([FormPayload, QuestionPayload]),
  }),
  Schema.Struct({ ...ItemBase, kind: Schema.Literal("subagent_question"), payload: SubagentQuestionPayload }),
  Schema.Struct({ ...ItemBase, kind: Schema.Literal("guardrail"), payload: GuardrailPayload }),
  Schema.Struct({ ...ItemBase, kind: Schema.Literal("permission"), payload: PermissionPayload }),
  Schema.Struct({ ...ItemBase, kind: Schema.Literal("recovery"), payload: RecoveryPayload }),
])
  .pipe(Schema.toTaggedUnion("kind"))
  .annotate({ identifier: "SessionReview.Item" })
export type Item = typeof Item.Type

export const Decision = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("question"),
    answers: Schema.Union([Form.Answer, Schema.Array(Question.Answer)]),
  }),
  Schema.Struct({
    kind: Schema.Literal("subagent_question"),
    text: SessionOrchestration.ControlText,
    data: SessionOrchestration.AnswerData.pipe(optional),
  }),
  Schema.Struct({ kind: Schema.Literal("guardrail"), reply: Guardrail.Reply }),
  Schema.Struct({ kind: Schema.Literal("permission"), reply: Permission.Reply }),
  Schema.Struct({ kind: Schema.Literal("recovery"), choice: Schema.Literals(["continue", "stop"]) }),
  Schema.Struct({ kind: Schema.Literals(["question", "subagent_question"]), dismissed: Schema.Literal(true) }),
]).annotate({ identifier: "SessionReview.Decision" })
export type Decision = typeof Decision.Type
