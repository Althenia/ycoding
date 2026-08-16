export * as SessionOrchestration from "./session-orchestration.js"

import { Schema } from "effect"
import { Agent } from "./agent.js"
import { Model } from "./model.js"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionDelivery } from "./session-delivery.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

const encoder = new TextEncoder()
export const truncateUtf8 = (input: string, bytes: number) => {
  if (encoder.encode(input).byteLength <= bytes) return input
  const characters = Array.from(input)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (encoder.encode(characters.slice(0, middle).join("")).byteLength <= bytes) low = middle
    else high = middle - 1
  }
  return characters.slice(0, low).join("")
}
const maxBytes = (bytes: number) =>
  Schema.makeFilter<string>((input) => encoder.encode(input).byteLength <= bytes, {
    expected: `a UTF-8 string of at most ${bytes} bytes`,
    meta: { _tag: "isMaxLength", maxLength: bytes },
    arbitrary: { constraint: { maxLength: bytes } },
  })
const boundedText = (bytes: number) => Schema.String.check(Schema.isMaxLength(bytes), maxBytes(bytes))
const jsonBytes = (bytes: number) =>
  Schema.makeFilter<Schema.Json>((input) => encoder.encode(JSON.stringify(input)).byteLength <= bytes, {
    expected: `JSON totaling at most ${bytes} UTF-8 bytes`,
    meta: { _tag: "isMaxLength", maxLength: bytes },
    arbitrary: { constraint: {} },
  })

export const DescriptionText = boundedText(4 * 1024)
export const PromptText = boundedText(64 * 1024)
export const ControlText = boundedText(64 * 1024)
export const ToolCallID = boundedText(512)
export const FailureText = boundedText(16 * 1024)
export const AnswerData = Schema.Json.check(jsonBytes(8 * 1024))
export const ProgressText = boundedText(4 * 1024)
export const QuestionText = boundedText(8 * 1024)
export const TerminalExcerpt = boundedText(16 * 1024)

export const State = Schema.Literals([
  "starting",
  "running",
  "waiting",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
  "lost",
])
export type State = typeof State.Type

export const TerminalState = Schema.Literals(["cancelled", "completed", "failed", "lost"])
export type TerminalState = typeof TerminalState.Type

export const QuestionID = Schema.String.check(Schema.isStartsWith("qst_")).pipe(Schema.brand("SessionTask.QuestionID"))
export type QuestionID = typeof QuestionID.Type

export const Progress = Schema.Struct({
  text: ProgressText,
  time: NonNegativeInt,
}).annotate({ identifier: "SessionOrchestration.Progress" })
export interface Progress extends Schema.Schema.Type<typeof Progress> {}

export const Question = Schema.Struct({
  id: QuestionID,
  text: QuestionText,
  data: AnswerData.pipe(optional),
  time: NonNegativeInt,
}).annotate({ identifier: "SessionOrchestration.Question" })
export interface Question extends Schema.Schema.Type<typeof Question> {}

export const Answer = Schema.Struct({
  questionID: QuestionID,
  text: ControlText.pipe(optional),
  data: AnswerData.pipe(optional),
}).annotate({ identifier: "SessionOrchestration.Answer" })
export interface Answer extends Schema.Schema.Type<typeof Answer> {}

export const Task = Schema.Struct({
  sessionID: SessionID,
  parentID: SessionID,
  description: DescriptionText,
  agent: Agent.ID,
  model: Model.Ref,
  background: Schema.Boolean,
  state: State,
  progress: Progress.pipe(optional),
  question: Question.pipe(optional),
  revision: NonNegativeInt,
  time: Schema.Struct({
    created: NonNegativeInt,
    updated: NonNegativeInt,
  }),
}).annotate({ identifier: "SessionOrchestration.Task" })
export interface Task extends Schema.Schema.Type<typeof Task> {}

export const TeamView = Schema.Struct({
  children: Schema.Array(Task),
  omitted: NonNegativeInt,
}).annotate({ identifier: "SessionOrchestration.TeamView" })
export interface TeamView extends Schema.Schema.Type<typeof TeamView> {}

export const Control = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list") }),
  Schema.Struct({
    action: Schema.Literal("send"),
    sessionID: SessionID,
    text: ControlText,
    delivery: SessionDelivery.Delivery,
  }),
  Schema.Struct({
    action: Schema.Literal("answer"),
    sessionID: SessionID,
    questionID: QuestionID,
    text: ControlText.pipe(optional),
    data: AnswerData.pipe(optional),
  }),
  Schema.Struct({ action: Schema.Literal("cancel"), sessionID: SessionID }),
  Schema.Struct({ action: Schema.Literal("resume"), sessionID: SessionID }),
]).pipe(Schema.toTaggedUnion("action"))
export type Control = typeof Control.Type

export const Report = Schema.Union([
  Schema.Struct({ action: Schema.Literal("progress"), text: ProgressText }),
  Schema.Struct({ action: Schema.Literal("question"), text: QuestionText, data: AnswerData.pipe(optional) }),
]).pipe(Schema.toTaggedUnion("action"))
export type Report = typeof Report.Type

export const NotificationType = Schema.Literals(["question", "completed", "failed", "cancelled", "lost"])
export type NotificationType = typeof NotificationType.Type

export const Notification = Schema.Struct({
  id: Schema.String,
  parentID: SessionID,
  childID: SessionID,
  type: NotificationType,
  excerpt: TerminalExcerpt.pipe(optional),
  revision: NonNegativeInt,
}).annotate({ identifier: "SessionOrchestration.Notification" })
export interface Notification extends Schema.Schema.Type<typeof Notification> {}

export const Change = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("launched"),
    parentID: SessionID,
    parentAssistantMessageID: SessionMessage.ID,
    toolCallID: ToolCallID,
    inputID: SessionMessage.ID,
    description: DescriptionText,
    agent: Agent.ID,
    model: Model.Ref,
    promptDigest: Schema.String,
    background: Schema.Boolean,
    delivery: SessionDelivery.Delivery,
  }),
  Schema.Struct({ type: Schema.Literal("started") }),
  Schema.Struct({ type: Schema.Literal("backgrounded") }),
  Schema.Struct({ type: Schema.Literal("progressed"), progress: Progress }),
  Schema.Struct({ type: Schema.Literal("question_asked"), question: Question }),
  Schema.Struct({ type: Schema.Literal("question_answered"), answer: Answer }),
  Schema.Struct({ type: Schema.Literal("cancel_requested") }),
  Schema.Struct({ type: Schema.Literal("cancelled") }),
  Schema.Struct({ type: Schema.Literal("completed"), excerpt: TerminalExcerpt.pipe(optional) }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    error: FailureText,
    excerpt: TerminalExcerpt.pipe(optional),
  }),
  Schema.Struct({ type: Schema.Literal("lost"), excerpt: TerminalExcerpt.pipe(optional) }),
]).pipe(Schema.toTaggedUnion("type"))
export type Change = typeof Change.Type
