export * as SessionOrchestration from "./orchestration"
import { SessionUsageAttribution } from "./usage-attribution"

import type { Model } from "@ycoding-ai/schema/model"
import { ModelSwitchBlocked } from "@ycoding-ai/schema/session"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { Form } from "@ycoding-ai/schema/form"
import {
  Question,
  QuestionID,
  Task,
  truncateUtf8,
  ListAnchor,
  type Change,
  type State,
} from "@ycoding-ai/schema/session-orchestration"
import { Agent } from "../agent"
import { Config } from "../config"
import { Database } from "../database/database"
import { Decision } from "../decision"
import { DecisionChoice } from "../decision-choice"
import { LocationServiceMap } from "../location-service-map"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { KeyedMutex } from "../effect/keyed-mutex"
import { Permission } from "../permission"
import { Hash } from "../util/hash"
import { canonicalJSON } from "./context-manifest"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { and, asc, count, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm"
import { Session } from "../session"
import { SessionExecution } from "./execution"
import { SessionStepBoundary } from "./step-boundary"
import { CoordinationModel } from "./coordination-model"
import { AppProcess } from "../process"
import { ShellLedger } from "../shell/ledger"
import { SessionAutonomy } from "./autonomy"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionPermissionCeiling } from "./permission-ceiling"
import { SessionOrchestrationIdentity } from "./orchestration-identity"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionMessageTable, SessionPendingTable, SessionTable, SessionTaskTable } from "./sql"
import { isTerminal, readTeamView, renderTeamView, taskFromRow, withReviewState } from "./orchestration-view"
import { SessionReviewFold } from "./review-fold"
import { SessionPending } from "./pending"
import { SessionSharedContext } from "./shared-context"

export { isTerminal, readTeamView, renderTeamView }
const PageSize = 10
type DatabaseService = Database.Interface["db"]
export { truncateUtf8 }
export const failureText = (input: string) => truncateUtf8(input, 16 * 1024)

export interface DotsSettlement {
  readonly explicitDecision?: true
  readonly source: Form.DotsClientReplySource
  readonly fingerprint: string
  readonly validate: () => Effect.Effect<boolean>
  readonly target?: { readonly kind: "review"; readonly itemID: SessionReview.ID; readonly fingerprint: string }
}

export function questionFingerprint(task: Task) {
  return Hash.json({
    sessionID: task.sessionID, parentID: task.parentID, description: task.description, agent: task.agent,
    model: task.model, background: task.background, state: task.state, revision: task.revision,
    progress: task.progress, time: task.time,
    question: task.question === undefined ? undefined : { id: task.question.id, text: task.question.text, data: task.question.data, time: task.question.time },
  })
}

export const selectModel = (
  spawn: Model.Ref | undefined,
  agent: Model.Ref | undefined,
  parent: Model.Ref | undefined,
) => spawn ?? agent ?? parent

const taskRank = (state: State): ListAnchor["rank"] => {
  if (state === "waiting") return 0
  if (state === "starting") return 1
  if (state === "running") return 2
  if (state === "cancelling") return 3
  return 4
}

const taskPriority = sql<number>`case ${SessionTaskTable.state}
  when 'waiting' then 0
  when 'starting' then 1
  when 'running' then 2
  when 'cancelling' then 3
  else 4
end`
const pinPriority = sql<number>`case when ${SessionTable.time_pinned} is null then 1 else 0 end`
const orderedTaskPriority = sql<number>`case when ${SessionTable.time_pinned} is null then ${taskPriority} else 0 end`
const orderedUpdated = sql<number>`case when ${SessionTable.time_pinned} is null then ${SessionTaskTable.time_updated} else 0 end`

export type Page = {
  readonly data: ReadonlyArray<Task>
  readonly summary: {
    readonly total: number
    readonly active: number
    readonly running: number
    readonly waiting: number
  }
  readonly cursor: {
    readonly previous?: ListAnchor
    readonly next?: ListAnchor
  }
}

export const page = Effect.fn("SessionOrchestration.page")(function* (
  db: DatabaseService,
  input: { readonly parentID: SessionSchema.ID; readonly limit?: number; readonly cursor?: ListAnchor },
) {
  const limit = Math.min(input.limit ?? PageSize, PageSize)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const parent = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, input.parentID))
          .get()
          .pipe(Effect.orDie)
        if (!parent) return yield* new Session.NotFoundError({ sessionID: input.parentID })

        const summary = yield* db
          .select({
            total: count(),
            active: sql<number>`coalesce(sum(case when ${SessionTaskTable.state} in ('starting', 'running', 'waiting', 'cancelling') then 1 else 0 end), 0)`,
            running: sql<number>`coalesce(sum(case when ${SessionTaskTable.state} = 'running' then 1 else 0 end), 0)`,
            waiting: sql<number>`coalesce(sum(case when ${SessionTaskTable.state} = 'waiting' then 1 else 0 end), 0)`,
          })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.parent_id, input.parentID))
          .get()
          .pipe(Effect.orDie)
        const cursor = input.cursor
        const previous = cursor?.direction === "previous"
        const boundary = cursor
          ? cursor.rank === 5
            ? previous
              ? and(eq(pinPriority, 0), or(lt(SessionTable.time_pinned, cursor.updated), and(eq(SessionTable.time_pinned, cursor.updated), lt(SessionTaskTable.session_id, cursor.sessionID))))
              : or(eq(pinPriority, 1), and(eq(pinPriority, 0), or(gt(SessionTable.time_pinned, cursor.updated), and(eq(SessionTable.time_pinned, cursor.updated), gt(SessionTaskTable.session_id, cursor.sessionID)))))
            : previous
              ? or(eq(pinPriority, 0), and(eq(pinPriority, 1), or(lt(taskPriority, cursor.rank), and(eq(taskPriority, cursor.rank), gt(SessionTaskTable.time_updated, cursor.updated)), and(eq(taskPriority, cursor.rank), eq(SessionTaskTable.time_updated, cursor.updated), lt(SessionTaskTable.session_id, cursor.sessionID)))))
              : and(eq(pinPriority, 1), or(gt(taskPriority, cursor.rank), and(eq(taskPriority, cursor.rank), lt(SessionTaskTable.time_updated, cursor.updated)), and(eq(taskPriority, cursor.rank), eq(SessionTaskTable.time_updated, cursor.updated), gt(SessionTaskTable.session_id, cursor.sessionID))))
          : undefined
        const rows = yield* db
          .select({ task: SessionTaskTable, pinnedAt: SessionTable.time_pinned })
          .from(SessionTaskTable)
          .innerJoin(SessionTable, eq(SessionTable.id, SessionTaskTable.session_id))
          .where(and(eq(SessionTaskTable.parent_id, input.parentID), boundary))
          .orderBy(
            previous ? desc(pinPriority) : asc(pinPriority),
            previous ? desc(SessionTable.time_pinned) : asc(SessionTable.time_pinned),
            previous ? desc(orderedTaskPriority) : asc(orderedTaskPriority),
            previous ? asc(orderedUpdated) : desc(orderedUpdated),
            previous ? desc(SessionTaskTable.session_id) : asc(SessionTaskTable.session_id),
          )
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const hasMore = rows.length > limit
        const selected = previous ? rows.slice(0, limit).toReversed() : rows.slice(0, limit)
        const tasks = yield* withReviewState(db, selected.map((row) => taskFromRow(row.task)))
        const data = tasks.map((task, index) => ({ ...task, pinnedAt: selected[index]?.pinnedAt ?? undefined }))
        const first = data[0]
        const last = data.at(-1)
        const previousCursor =
          first && (previous ? hasMore : cursor !== undefined)
            ? ListAnchor.make({
                rank: first.pinnedAt === undefined ? taskRank(first.state) : 5,
                updated: first.pinnedAt ?? first.time.updated,
                sessionID: first.sessionID,
                direction: "previous",
              })
            : undefined
        const nextCursor =
          last && (previous ? cursor !== undefined : hasMore)
            ? ListAnchor.make({
                rank: last.pinnedAt === undefined ? taskRank(last.state) : 5,
                updated: last.pinnedAt ?? last.time.updated,
                sessionID: last.sessionID,
                direction: "next",
              })
            : undefined
        return {
          data,
          summary: {
            total: summary?.total ?? 0,
            active: summary?.active ?? 0,
            running: summary?.running ?? 0,
            waiting: summary?.waiting ?? 0,
          },
          cursor: {
            previous: previousCursor,
            next: nextCursor,
          },
        }
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export const snapshot = Effect.fn("SessionOrchestration.snapshot")(function* (
  db: DatabaseService,
  parentID: SessionSchema.ID,
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const parent = yield* db
          .select({ sequence: SessionTable.orchestration_revision })
          .from(SessionTable)
          .where(eq(SessionTable.id, parentID))
          .get()
          .pipe(Effect.orDie)
        if (!parent) return yield* new Session.NotFoundError({ sessionID: parentID })
        const versions = yield* db
          .select({ sessionID: SessionTaskTable.session_id, revision: SessionTaskTable.revision })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.parent_id, parentID))
          .orderBy(asc(SessionTaskTable.session_id))
          .all()
          .pipe(Effect.orDie)
        return { sequence: parent.sequence, digest: Hash.sha256(canonicalJSON(versions)) }
      }),
    )
    .pipe(Effect.catchTag("SqlError", Effect.die))
})

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionOrchestration.NotFoundError", {
  parentID: SessionSchema.ID,
  childID: SessionSchema.ID,
}) {
  override get message() {
    return `Child task not found for parent ${this.parentID}: ${this.childID}`
  }
}

export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()("SessionOrchestration.ForbiddenError", {
  parentID: SessionSchema.ID,
  childID: SessionSchema.ID,
}) {
  override get message() {
    return `Control of child ${this.childID} by session ${this.parentID} is not permitted`
  }
}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()(
  "SessionOrchestration.TaskNotFoundError",
  { childID: SessionSchema.ID },
) {
  override get message() {
    return `Child task not found: ${this.childID}`
  }
}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionOrchestration.ConflictError", {
  message: Schema.String,
}) {}

export class ModelBlockedError extends Schema.TaggedErrorClass<ModelBlockedError>()("SessionOrchestration.ModelBlockedError", {
  blocked: ModelSwitchBlocked,
}) {
  override get message() {
    return `Model switch blocked: current context (${this.blocked.currentContextTokens} tokens) exceeds the target model's safe input (${this.blocked.targetSafeInputTokens} tokens); reduce context by ${this.blocked.requiredReductionTokens} tokens and retry`
  }
}

export class InvalidRequestError extends Schema.TaggedErrorClass<InvalidRequestError>()(
  "SessionOrchestration.InvalidRequestError",
  { message: Schema.String },
) {}

export class ServiceUnavailableError extends Schema.TaggedErrorClass<ServiceUnavailableError>()(
  "SessionOrchestration.ServiceUnavailableError",
  { message: Schema.String },
) {}

export class QuestionNotFoundError extends Schema.TaggedErrorClass<QuestionNotFoundError>()(
  "SessionOrchestration.QuestionNotFoundError",
  { childID: SessionSchema.ID, questionID: QuestionID },
) {
  override get message() {
    return `Open question ${this.questionID} not found for child ${this.childID}`
  }
}

export interface ModelSource {
  readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID
  readonly callID: string
}

export interface LaunchInput {
  readonly parentID: SessionSchema.ID
  readonly parentAssistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly agent: Agent.ID
  readonly description: string
  readonly prompt: string
  readonly sharedContext?: SessionSharedContext.Selection
  readonly background: boolean
  readonly model?: Model.Ref
  readonly prepared: Prepared
}

export interface Prepared {
  readonly target: Agent.Info
  readonly caller: Agent.Info
  readonly resolved: SessionRunnerModel.Resolved
}

export const preflight = Effect.fn("SessionOrchestration.preflight")(function* (
  parent: SessionSchema.Info,
  input: { readonly agent: Agent.ID; readonly model?: Model.Ref; readonly caller?: Agent.ID },
) {
  const agents = yield* Agent.Service
  const target = yield* agents.resolve(input.agent)
  if (!target) return yield* new InvalidRequestError({ message: `Unknown agent: ${input.agent}` })
  if (target.mode === "primary")
    return yield* new InvalidRequestError({ message: `Agent ${input.agent} cannot run as a subagent` })
  const caller = yield* agents.resolve(input.caller ?? parent.agent)
  if (!caller) return yield* new InvalidRequestError({ message: "Parent agent is unavailable" })
  const models = yield* SessionRunnerModel.Service
  const resolved = yield* models
    .resolve(
      { ...parent, model: selectModel(input.model, target.model, parent.model) },
      { rebind: input.model?.profile !== undefined || target.model?.profile !== undefined },
    )
    .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))
  return { target, caller, resolved }
})

export const authorize = Effect.fn("SessionOrchestration.authorize")(function* (
  parentID: SessionSchema.ID,
  target: Agent.ID,
  source: ModelSource,
  operationDigest: string,
) {
  const permission = yield* Permission.Service
  yield* permission.assert({
    action: "subagent",
    resources: [target],
    save: [target],
    metadata: { operationDigest },
    sessionID: parentID,
    agent: source.agent,
    source: { type: "tool", messageID: source.messageID, callID: source.callID },
  })
})

export interface Interface {
  readonly managed: (childID: SessionSchema.ID) => Effect.Effect<boolean>
  readonly get: (
    parentID: SessionSchema.ID,
    childID: SessionSchema.ID,
  ) => Effect.Effect<Task, Session.NotFoundError | NotFoundError | ForbiddenError>
  readonly launch: (input: LaunchInput) => Effect.Effect<Task, LaunchError>
  readonly switchModel: (input: {
    readonly parentID: SessionSchema.ID
    readonly childID: SessionSchema.ID
    readonly expectedModel: Model.Ref
    readonly model: Model.Ref
    readonly source: { readonly type: "native" } | ({ readonly type: "tool" } & ModelSource)
  }) => Effect.Effect<Task, ControlError | InvalidRequestError | ModelBlockedError | SessionRunnerModel.Error | Session.MessageDecodeError | Session.CompactionConflictError | Permission.Error>
  readonly list: (parentID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Task>, Session.NotFoundError>
  readonly questionSnapshots: (parentID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<{ readonly task: Task; readonly fingerprint: string }>, Session.NotFoundError>
  readonly page: (input: {
    readonly parentID: SessionSchema.ID
    readonly limit?: number
    readonly cursor?: ListAnchor
  }) => Effect.Effect<Page, Session.NotFoundError>
  readonly send: (input: {
    readonly parentID: SessionSchema.ID
    readonly childID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly text: string
    readonly delivery: "steer" | "queue"
  }) => Effect.Effect<Task, ControlError>
  readonly answer: (input: {
    readonly parentID: SessionSchema.ID
    readonly childID: SessionSchema.ID
    readonly questionID: QuestionID
    readonly text?: string
    readonly data?: Schema.Json
    readonly origin?: "review" | "dots-review"
    readonly dots?: DotsSettlement
    readonly reviewDecision?: { readonly itemID: SessionReview.ID; readonly decision: SessionReview.Decision }
  }) => Effect.Effect<Task, AnswerError>
  readonly cancel: (input: {
    readonly parentID: SessionSchema.ID
    readonly childID: SessionSchema.ID
  }) => Effect.Effect<Task, ControlError>
  readonly notice: (input: {
    readonly sessionID: SessionSchema.ID
    readonly shellID: string
    readonly text: string
    readonly description?: string
    readonly metadata?: Record<string, unknown>
    readonly resume: boolean
  }) => ReturnType<Session.Interface["synthetic"]>
  readonly resume: (input: {
    readonly parentID: SessionSchema.ID
    readonly childID: SessionSchema.ID
  }) => Effect.Effect<Task, ControlError>
  readonly progress: (childID: SessionSchema.ID, text: string) => Effect.Effect<Task, TaskNotFoundError | ConflictError>
  readonly question: (
    childID: SessionSchema.ID,
    text: string,
    data?: Schema.Json,
  ) => Effect.Effect<{ readonly question: Question; readonly autoAnswered: boolean }, TaskNotFoundError | ConflictError>
  readonly settle: (
    childID: SessionSchema.ID,
    result:
      | { readonly type: "completed"; readonly excerpt?: string }
      | { readonly type: "failed"; readonly error: string; readonly excerpt?: string }
      | { readonly type: "lost"; readonly excerpt?: string },
  ) => Effect.Effect<Task, TaskNotFoundError | ConflictError>
  readonly background: (childID: SessionSchema.ID) => Effect.Effect<Task, TaskNotFoundError | ConflictError>
  readonly teamView: (
    parentID: SessionSchema.ID,
  ) => Effect.Effect<ReturnType<typeof renderTeamView>, Session.NotFoundError>
  readonly recover: Effect.Effect<void>
  readonly resolveRecovery: (input: {
    readonly childID: SessionSchema.ID
    readonly itemID: SessionReview.ID
    readonly choice: "continue" | "stop"
    readonly dots?: DotsSettlement
  }) => Effect.Effect<Task, TaskNotFoundError | ConflictError>
}

export type Error =
  | Session.NotFoundError
  | NotFoundError
  | TaskNotFoundError
  | ForbiddenError
  | ConflictError
  | InvalidRequestError
  | ServiceUnavailableError
  | QuestionNotFoundError
  | Permission.Error

export type OwnershipError = Session.NotFoundError | NotFoundError | ForbiddenError
export type LaunchError = Session.NotFoundError | ConflictError | InvalidRequestError
export type ControlError = OwnershipError | ConflictError
export type AnswerError = ControlError | InvalidRequestError | QuestionNotFoundError

export class Service extends Context.Service<Service, Interface>()("@ycoding/SessionOrchestration") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventRuntime.Service
    const execution = yield* SessionExecution.Service
    const stepBoundary = yield* SessionStepBoundary.Service
    const processService = yield* AppProcess.Service
    const owner = yield* ShellLedger.identify(processService, process.pid)
    const sessions = yield* Session.Service
    const autonomy = yield* SessionAutonomy.Service
    const locations = yield* LocationServiceMap.Service
    const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

    type SleepAnswerOutcome =
      | { readonly type: "answer"; readonly text: string; readonly confidence?: number }
      | {
          readonly type: "defer"
          readonly reason: "disabled" | "free_text" | "error" | DecisionChoice.UnsettledReason
          readonly choice?: string
          readonly confidence?: number
        }

    const sleepAnswer = Effect.fn("SessionOrchestration.sleepAnswer")(function* (input: {
      childID: SessionSchema.ID
      text: string
      data?: Schema.Json
      autoAnswer: boolean
      yolo: boolean
      questionID: string
    }): Effect.fn.Return<SleepAnswerOutcome> {
      const options = questionOptions(input.data)
      const marked = options.filter((option) => /\s\(Recommended\)$/.test(option))
      if (input.autoAnswer && marked.length === 1 && marked[0] !== undefined) return { type: "answer", text: marked[0] }
      if (!input.yolo) return { type: "defer", reason: options.length === 0 ? "free_text" : "disabled" }
      const child = yield* sessions
        .get(input.childID)
        .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined)))
      if (!child) return { type: "defer", reason: "error" }
      const decision = yield* Decision.Service.pipe(Effect.provide(locations.get(child.location)), Effect.exit)
      if (decision._tag === "Failure") return { type: "defer", reason: "error" }
      const call = {
        sessionID: input.childID,
        name: "subagent_question",
        purpose: "answer" as const,
        authority: "yolo" as const,
        invocationKey: input.questionID,
      }
      if (options.length === 0) {
        const outcome = yield* DecisionChoice.answerText(decision.value, {
          ...call,
          instructions:
            "The user cannot answer this subagent's question right now. Give the bounded free-text answer that best serves the question with the evidence given. Refuse when the evidence does not support an answer; refusal defers the question to the user.",
          state: { question: input.text },
        })
        if (outcome.type === "text") return { type: "answer", text: outcome.value, confidence: outcome.confidence }
        return {
          type: "defer",
          reason: outcome.reason,
          ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
        }
      }
      const outcome = yield* DecisionChoice.chooseDetailed(decision.value, {
        ...call,
        instructions:
          "The user cannot answer this subagent's question right now. Choose the option that best serves the question with the evidence given. Refuse when the evidence does not support a choice; refusal defers the question to the user.",
        state: { question: input.text, options },
        choices: options.map((value) => ({ value })),
      })
      if (outcome.type === "judgment") return { type: "answer", text: outcome.value, confidence: outcome.confidence }
      return {
        type: "defer",
        reason: outcome.reason,
        ...(outcome.choice === undefined ? {} : { choice: outcome.choice }),
        ...(outcome.confidence === undefined ? {} : { confidence: outcome.confidence }),
      }
    })

    const task = Effect.fn("SessionOrchestration.task")(function* (childID: SessionSchema.ID) {
      return yield* db
        .select()
        .from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, childID))
        .get()
        .pipe(Effect.orDie)
    })

    const owned = Effect.fn("SessionOrchestration.owned")(function* (
      parentID: SessionSchema.ID,
      childID: SessionSchema.ID,
    ) {
      yield* sessions.get(parentID)
      const row = yield* task(childID)
      if (row?.parent_id === parentID) return row
      const child = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, childID))
        .get()
        .pipe(Effect.orDie)
      if (child) return yield* new ForbiddenError({ parentID, childID })
      return yield* new NotFoundError({ parentID, childID })
    })

    const publish = (childID: SessionSchema.ID, change: typeof SessionEvent.Task.Updated.Type["data"]["change"], id?: string) =>
      events.publish(
        SessionEvent.Task.Updated,
        { sessionID: childID, change },
        { id: id ? EventRuntime.ID.make(id) : undefined },
      )

    const current = Effect.fn("SessionOrchestration.current")(function* (childID: SessionSchema.ID) {
      const row = yield* task(childID)
      if (!row) return yield* Effect.die(new Error(`Projected task missing: ${childID}`))
      return (yield* withReviewState(db, [taskFromRow(row)]))[0]!
    })

    const causalInput = Effect.fn("SessionOrchestration.causalInput")(function* (
      sessionID: SessionSchema.ID,
      beforeSeq: number,
    ): Effect.fn.Return<typeof SessionMessageTable.$inferSelect | undefined> {
      const input = yield* db.select({ message: SessionMessageTable, event: EventTable }).from(SessionMessageTable)
        .leftJoin(EventTable, and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.seq, SessionMessageTable.seq)))
        .where(and(eq(SessionMessageTable.session_id, sessionID), lt(SessionMessageTable.seq, beforeSeq), inArray(SessionMessageTable.type, ["user", "synthetic"])))
        .orderBy(desc(SessionMessageTable.seq)).limit(1).get().pipe(Effect.orDie)
      if (!input) return undefined
      if (input.message.type === "user") return input.message
      const synthetic = Schema.decodeUnknownOption(SessionMessage.Synthetic)({ ...input.message.data, id: input.message.id, type: input.message.type })
      if (synthetic._tag === "None") return undefined
      if (input.event?.type !== EventRuntime.versionedType(SessionEvent.ContextObserved.type, SessionEvent.ContextObserved.durable.version) ||
        input.event.data.sessionID !== sessionID || input.event.data.source !== "team-view" ||
        SessionMessage.ID.fromEvent(input.event.id) !== input.message.id || input.event.data.text !== synthetic.value.text)
        return undefined
      return yield* causalInput(sessionID, input.message.seq)
    })

    const nativeCause = Effect.fn("SessionOrchestration.nativeCause")(function* (
      sessionID: SessionSchema.ID,
      messageID: SessionMessage.ID,
      seen: ReadonlySet<SessionSchema.ID> = new Set(),
    ): Effect.fn.Return<boolean> {
      if (seen.has(sessionID) || seen.size >= 64) return false
      const assistant = yield* db.select({ seq: SessionMessageTable.seq }).from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, messageID), eq(SessionMessageTable.type, "assistant")))
        .get().pipe(Effect.orDie)
      if (!assistant) return false
      const input = yield* causalInput(sessionID, assistant.seq)
      if (!input) return false
      const decoded = Schema.decodeUnknownOption(SessionMessage.User)({ ...input.data, id: input.id, type: input.type })
      if (decoded._tag === "None") return false
      if (decoded.value.metadata?.inputOrigin === "direct") return true
      if (decoded.value.metadata?.inputOrigin !== "subagent") return false
      const child = yield* task(sessionID)
      if (!child) return false
      return yield* nativeCause(child.parent_id, child.parent_assistant_message_id, new Set([...seen, sessionID]))
    })

    const switchable = Effect.fn("SessionOrchestration.switchable")(function* (input: Parameters<Interface["switchModel"]>[0]) {
      const row = yield* owned(input.parentID, input.childID)
      if (row.state === "starting" || row.state === "cancelling")
        return yield* new ConflictError({ message: "Wait for the child's lifecycle transition before selecting a model" })
      if (row.owner_pid !== null && (row.owner_pid !== process.pid || owner === undefined || row.owner_started !== owner.started))
        return yield* new ConflictError({ message: "The child is owned by another runtime process" })
      const parent = yield* sessions.get(input.parentID)
      const child = yield* sessions.get(input.childID)
      if (parent.time.archived !== undefined || child.time.archived !== undefined)
        return yield* new ConflictError({ message: "Archived Sessions cannot change a child model" })
      if (input.source.type === "tool" && !(yield* nativeCause(input.parentID, input.source.messageID)))
        return yield* new ForbiddenError({ parentID: input.parentID, childID: input.childID })
      if (yield* CoordinationModel.override(db, input.childID))
        return yield* new ConflictError({ message: "The child has an active coordination model override" })
      return row
    })

    const result: Interface = {
      questionSnapshots: Effect.fn("SessionOrchestration.questionSnapshots")(function* (parentID) {
        return (yield* result.list(parentID)).filter((task) => task.state === "waiting" && task.question !== undefined && !task.question.deferred)
          .map((task) => ({ task, fingerprint: questionFingerprint(task) }))
      }),
      switchModel: Effect.fn("SessionOrchestration.switchModel")((input) =>
        stepBoundary.withSelection(input.childID, execution.withTransition(input.childID, Effect.gen(function* () {
          yield* switchable(input)
          const child = yield* sessions.get(input.childID)
          const models = yield* SessionRunnerModel.Service.pipe(Effect.provide(locations.get(child.location)))
          const resolved = yield* models.resolve({ ...child, model: input.model }, { refresh: false })
          return yield* stepBoundary.atBoundary(input.childID, locks.withLock(input.childID)(Effect.gen(function* () {
            const row = yield* switchable(input)
            if (input.source.type === "tool") {
              const parent = yield* sessions.get(input.parentID)
              yield* authorize(input.parentID, Agent.ID.make(row.agent), input.source, Hash.json({
                action: "switch_model", sessionID: input.childID, expectedModel: input.expectedModel, model: input.model,
              })).pipe(Effect.provide(locations.get(parent.location)))
            }
            const selected = yield* sessions.selectModelAtBoundary({
              sessionID: input.childID, expectedModel: input.expectedModel, model: input.model,
              connectionIdentityDigest: resolved.connectionIdentityDigest,
              guard: Effect.gen(function* () {
                yield* switchable(input)
                if (input.source.type !== "tool") return true
                const parent = yield* sessions.get(input.parentID)
                const permission = yield* Permission.Service.pipe(Effect.provide(locations.get(parent.location)))
                return (yield* permission.evaluateEffective({ sessionID: input.parentID, agent: input.source.agent, action: "subagent", resource: row.agent })) !== "deny"
              }).pipe(Effect.catch(() => Effect.succeed(false))),
            })
            if (selected.status === "conflict") return yield* new ConflictError({ message: "The child or expected model changed before selection; read the child and retry" })
            if (selected.status === "blocked") return yield* new ModelBlockedError({ blocked: selected })
            return yield* current(input.childID)
          })))
        }))),
      ),
      managed: Effect.fn("SessionOrchestration.managed")(function* (childID) {
        return (yield* task(childID)) !== undefined
      }),
      get: Effect.fn("SessionOrchestration.get")(function* (parentID, childID) {
        return (yield* withReviewState(db, [taskFromRow(yield* owned(parentID, childID))]))[0]!
      }),
      launch: Effect.fn("SessionOrchestration.launch")((input) => {
        const ids = SessionOrchestrationIdentity.launch(
          input.parentID,
          input.parentAssistantMessageID,
          input.toolCallID,
        )
        return locks.withLock(ids.childID)(
          Effect.gen(function* () {
            const parent = yield* sessions.get(input.parentID)
            const usageAnchor = yield* SessionUsageAttribution.dispatch(db, input.parentID)
            const prepared = input.prepared
            const promptDigest = input.sharedContext === undefined
              ? Hash.sha256(input.prompt)
              : Hash.json({ version: 1, prompt: input.prompt, messageIDs: input.sharedContext.messageIDs })
            const existing = yield* task(ids.childID)
            const admitted = yield* SessionPending.lookup(db, ids.childID, ids.inputID).pipe(
              Effect.catchDefect((defect) => defect instanceof SessionPending.LifecycleConflict
                ? Effect.fail(new ConflictError({ message: `Conflicting initial input for ${ids.childID}` }))
                : Effect.die(defect)),
            )
            if (existing && (
              existing.parent_id !== input.parentID ||
              existing.agent !== prepared.target.id ||
              existing.model.providerID !== prepared.resolved.ref.providerID ||
              existing.model.id !== prepared.resolved.ref.id ||
              existing.model.variant !== prepared.resolved.ref.variant ||
              existing.model.profile !== prepared.resolved.ref.profile ||
              existing.prompt_digest !== promptDigest ||
              existing.background !== input.background ||
              existing.delivery !== "steer"
            )) return yield* new ConflictError({ message: `Conflicting launch retry for ${ids.childID}` })
            const sharedContext = admitted === undefined && input.sharedContext !== undefined
              ? yield* SessionSharedContext.resolve(input.parentID, input.sharedContext, (sessionID, messageID) => sessions.message({ sessionID, messageID })).pipe(
                  Effect.mapError((error) => new InvalidRequestError({ message: error instanceof SessionSharedContext.InvalidSelectionError ? error.message : "Selected shared context is unavailable" })),
                )
              : undefined
            if (sharedContext !== undefined) {
              try {
                SessionSharedContext.compose(input.prompt, sharedContext)
              } catch (error) {
                if (error instanceof SessionSharedContext.InvalidSelectionError)
                  return yield* new InvalidRequestError({ message: error.message })
                throw error
              }
            }
            const start = Effect.gen(function* () {
              yield* sessions
                .prompt({
                  id: ids.inputID,
                  sessionID: ids.childID,
                  text: input.prompt,
                  sharedContext,
                  resume: false,
                  origin: "subagent",
                  causedBy: existing ? existing.usage_anchor ?? undefined : usageAnchor,
                })
                .pipe(
                  Effect.mapError((error) =>
                    error._tag === "Session.NotFoundError"
                      ? error
                      : error._tag === "Session.PromptConflictError"
                        ? new ConflictError({ message: `Conflicting initial input for ${ids.childID}` })
                        : new InvalidRequestError({ message: error.message }),
                  ),
                )
              yield* publish(ids.childID, { type: "started" }, `evt_task_started_${ids.childID.slice(-24)}`)
              yield* execution.wake(ids.childID)
              return yield* current(ids.childID)
            })
            if (existing) {
              if (existing.state === "starting") return yield* start
              return (yield* withReviewState(db, [taskFromRow(existing)]))[0]!
            }
            yield* sessions
              .create({
                id: ids.childID,
                parentID: input.parentID,
                title: input.description,
                agent: prepared.target.id,
                model: prepared.resolved.ref,
                profileBinding: prepared.resolved.profileBinding,
                permissionCeiling: SessionPermissionCeiling.inherit(
                  parent.permissionCeiling,
                  prepared.caller.permissions,
                ),
              })
              .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))
            yield* publish(
              ids.childID,
              {
                type: "launched",
                usageAnchor,
                parentID: input.parentID,
                parentAssistantMessageID: input.parentAssistantMessageID,
                toolCallID: input.toolCallID,
                inputID: ids.inputID,
                description: input.description,
                agent: prepared.target.id,
                model: prepared.resolved.ref,
                promptDigest,
                background: input.background,
                delivery: "steer",
              },
              ids.launchEventID,
            )
            return yield* start
          }),
        )
      }),
      list: Effect.fn("SessionOrchestration.list")(function* (parentID) {
        yield* sessions.get(parentID)
        const rows = yield* db
          .select()
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.parent_id, parentID))
          .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.session_id))
          .all()
          .pipe(Effect.orDie)
        return yield* withReviewState(db, rows.map(taskFromRow))
      }),
      page: Effect.fn("SessionOrchestration.page")((input) => page(db, input)),
      send: Effect.fn("SessionOrchestration.send")((input) =>
        locks.withLock(input.childID)(
          Effect.gen(function* () {
            const row = yield* owned(input.parentID, input.childID)
            if (row.state !== "running" && !isTerminal(row.state))
              return yield* new ConflictError({ message: `Cannot send to task in ${row.state}` })
            if ((yield* SessionReviewFold.stoppedRecovery(db, input.childID)) !== undefined)
              return yield* new ConflictError({
                message: `Subagent ${input.childID} was stopped after a service restart; only the user can continue it`,
              })
            yield* sessions
              .synthetic({
                id: input.messageID,
                sessionID: input.childID,
                causedBy: yield* SessionUsageAttribution.dispatch(db, input.parentID),
                text: `Parent message:\n${JSON.stringify({ text: input.text, delivery: input.delivery })}`,
                description: "Parent subagent message",
                metadata: {
                  source: "subagent_parent",
                  parentID: input.parentID,
                  childID: input.childID,
                  kind: "message",
                },
                delivery: input.delivery,
                resume: false,
              })
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "Session.NotFoundError"
                    ? error
                    : new ConflictError({ message: `Conflicting parent message for ${input.childID}` }),
                ),
              )
            const pending = db
              .select({ id: SessionPendingTable.id })
              .from(SessionPendingTable)
              .where(
                and(eq(SessionPendingTable.id, input.messageID), eq(SessionPendingTable.session_id, input.childID)),
              )
              .get()
              .pipe(Effect.orDie)
            if (!isTerminal(row.state)) {
              yield* execution.wake(input.childID)
              const latest = yield* task(input.childID)
              if (!latest || !isTerminal(latest.state)) return yield* current(input.childID)
            }
            if (!(yield* pending)) return (yield* withReviewState(db, [taskFromRow(row)]))[0]!
            yield* publish(input.childID, { type: "started" })
            yield* execution.wake(input.childID)
            return yield* current(input.childID)
          }),
        ),
      ),
      answer: Effect.fn("SessionOrchestration.answer")((input) =>
        locks.withLock(input.childID)(
          Effect.gen(function* () {
            const row = yield* owned(input.parentID, input.childID)
            if (row.question_id !== input.questionID)
              return yield* new QuestionNotFoundError({ childID: input.childID, questionID: input.questionID })
            if (row.state !== "waiting")
              return yield* new ConflictError({ message: `Question ${input.questionID} is not open` })
            const dots = input.dots
            const exact = Effect.gen(function* () {
              const latest = yield* task(input.childID)
              if (!latest || latest.revision !== row.revision || latest.question_id !== input.questionID || latest.state !== "waiting") return false
              const owner = yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).where(eq(SessionTable.id, input.childID)).get().pipe(Effect.orDie)
              if (!owner || owner.archived !== null) return false
              if (!dots) return true
              if (!dots.explicitDecision) return false
              if (dots.target) {
                if (dots.target.fingerprint !== dots.fingerprint || dots.target.itemID !== input.reviewDecision?.itemID) return false
                const review = (yield* SessionReviewFold.fold(db, [input.childID])).find((item) => item.itemID === dots.target?.itemID)
                if (!review || SessionReviewFold.pendingFingerprint(review) !== dots.fingerprint) return false
              } else if (questionFingerprint(yield* current(input.childID)) !== dots.fingerprint || (yield* SessionReviewFold.ownsQuestion(db, input.childID, input.questionID))) return false
              return yield* dots.validate()
            })
            if (dots && !(yield* exact)) return yield* new ConflictError({ message: "Dots child question authorization changed" })
            if (input.origin === "dots-review" && (!dots || !input.reviewDecision)) return yield* new InvalidRequestError({ message: "Dots review delivery requires validated provenance and decision" })
            if (input.origin === "review" && input.reviewDecision === undefined)
              return yield* new InvalidRequestError({ message: "Review delivery requires a review decision" })
            if (
              input.origin !== "review" && input.origin !== "dots-review" &&
              (yield* SessionReviewFold.ownsQuestion(db, input.childID, input.questionID))
            )
              return yield* new ConflictError({ message: `question ${input.questionID} awaits the user's review` })
            if (input.text === undefined && input.data === undefined)
              return yield* new InvalidRequestError({ message: "An answer requires text or data" })
            const id = SessionOrchestrationIdentity.launch(
              row.parent_id,
              row.parent_assistant_message_id,
              row.tool_call_id,
            ).answer(input.questionID)
            const causedBy = yield* SessionUsageAttribution.dispatch(db, input.parentID)
            const data = {
              text: `${dots ? "Authenticated Dots client" : "Parent"} answer:\n${JSON.stringify({ questionID: input.questionID, text: input.text, data: input.data })}`,
              description: dots ? "Dots subagent answer" : "Parent subagent answer",
              metadata: {
                source: "subagent_parent",
                parentID: input.parentID,
                childID: input.childID,
                kind: "answer",
                questionID: input.questionID,
                ...(dots === undefined ? {} : { dotsSource: dots.source }),
              },
            }
            const change = { type: "question_answered" as const, answer: { questionID: input.questionID, text: input.text, data: input.data, ...(dots === undefined ? {} : { source: dots.source }) } }
            const review = input.reviewDecision
            if (review) {
              if (input.origin !== "review" && input.origin !== "dots-review") return yield* new InvalidRequestError({ message: "A review decision requires review delivery" })
              const item = (yield* SessionReviewFold.fold(db, [input.childID])).find((item) => item.itemID === review.itemID)
              const matches = (item: SessionReviewFold.Folded | undefined) => item?.kind === "subagent_question" && item.withdrawn === undefined &&
                "questionID" in item.origin && item.origin.questionID === input.questionID &&
                (item.decision === undefined || Hash.json(item.decision) === Hash.json(review.decision))
              if (!matches(item)) return yield* new ConflictError({ message: "The child question is not owned by this review decision" })
              const prior = yield* SessionPending.lookup(db, input.childID, id).pipe(
                Effect.catchDefect((defect) => defect instanceof SessionPending.LifecycleConflict
                  ? Effect.fail(new ConflictError({ message: `Conflicting answer for ${input.questionID}` })) : Effect.die(defect)),
              )
              if (prior && (prior.type !== "synthetic" || Hash.json({ data: prior.data, delivery: prior.delivery }) !== Hash.json({ data, delivery: "steer" })))
                return yield* new ConflictError({ message: `Conflicting answer for ${input.questionID}` })
              const committed = yield* events.publishBatch([
                ...(prior === undefined ? [{ definition: SessionEvent.InputAdmitted, data: { sessionID: input.childID, inputID: id, causedBy,
                  input: SessionPending.Message.make({ type: "synthetic", data, delivery: "steer" }) } }] : []),
                { definition: SessionEvent.Task.Updated, data: { sessionID: input.childID, change } },
                ...(item?.decision === undefined ? [{ definition: SessionEvent.Review.Decided,
                  data: { sessionID: input.childID, itemID: review.itemID, decision: review.decision, ...(dots === undefined ? {} : { source: dots.source }) } }] : []),
                ...(dots === undefined ? [] : [{ definition: SessionEvent.DotsDecisionSettled, data: { sessionID: input.childID, source: dots.source,
                  target: dots.target ?? { kind: "subagent_question" as const, questionID: input.questionID, fingerprint: dots.fingerprint } } }]),
              ], { when: Effect.gen(function* () {
                if (!(yield* exact)) return false
                const latest = yield* task(input.childID)
                if (latest?.state !== "waiting" || latest.question_id !== input.questionID) return false
                const owner = yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).where(eq(SessionTable.id, input.childID)).get().pipe(Effect.orDie)
                if (!owner || owner.archived !== null) return false
                const current = (yield* SessionReviewFold.fold(db, [input.childID])).find((item) => item.itemID === review.itemID)
                if (!matches(current) || (current?.decision === undefined) !== (item?.decision === undefined)) return false
                const admitted = yield* SessionPending.lookup(db, input.childID, id).pipe(Effect.catchDefect((defect) =>
                  defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(false as const) : Effect.die(defect)))
                if (admitted === false || (admitted === undefined) !== (prior === undefined)) return false
                return admitted === undefined || (admitted.type === "synthetic" && Hash.json({ data: admitted.data, delivery: admitted.delivery }) === Hash.json({ data, delivery: "steer" }))
              }) })
              if (committed.length === 0) return yield* new ConflictError({ message: `Question ${input.questionID} changed before answer delivery` })
              yield* execution.wake(input.childID)
              return yield* current(input.childID)
            }
            if (dots) {
              const committed = yield* events.publishBatch([
                { definition: SessionEvent.InputAdmitted, data: { sessionID: input.childID, inputID: id, causedBy,
                  input: SessionPending.Message.make({ type: "synthetic", data, delivery: "steer" }) } },
                { definition: SessionEvent.Task.Updated, data: { sessionID: input.childID, change } },
                { definition: SessionEvent.DotsDecisionSettled, data: { sessionID: input.childID, source: dots.source,
                  target: { kind: "subagent_question", questionID: input.questionID, fingerprint: dots.fingerprint } } },
              ], { when: exact })
              if (committed.length === 0) return yield* new ConflictError({ message: "Dots child answer changed before delivery" })
              yield* execution.wake(input.childID)
              return yield* current(input.childID)
            }
            yield* sessions
              .synthetic({ id, sessionID: input.childID, causedBy, ...data, delivery: "steer", resume: false })
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "Session.NotFoundError"
                    ? error
                    : new ConflictError({ message: `Conflicting answer for ${input.questionID}` }),
                ),
              )
            yield* publish(input.childID, change)
            yield* execution.wake(input.childID)
            return yield* current(input.childID)
          }),
        ),
      ),
      cancel: Effect.fn("SessionOrchestration.cancel")((input) =>
        locks.withLock(input.childID)(
          Effect.gen(function* () {
            const row = yield* owned(input.parentID, input.childID)
            if (row.state === "cancelled") return (yield* withReviewState(db, [taskFromRow(row)]))[0]!
            if (row.state !== "starting" && row.state !== "running" && row.state !== "waiting")
              return yield* new ConflictError({ message: `Cannot cancel task in ${row.state}` })
            if (row.question_id) {
              const folded = yield* SessionReviewFold.fold(db, [input.childID])
              yield* Effect.forEach(
                folded.filter(
                  (item) => SessionReviewFold.isOpen(item) && "questionID" in item.origin && item.origin.questionID === row.question_id,
                ),
                (item) => SessionReviewFold.withdrawItem(events, input.childID, item.itemID, "task_closed"),
                { discard: true },
              )
            }
            yield* publish(input.childID, { type: "cancel_requested" })
            yield* execution.interrupt(input.childID)
            yield* publish(input.childID, { type: "cancelled" })
            return yield* current(input.childID)
          }),
        ),
      ),
      notice: Effect.fn("SessionOrchestration.notice")((input) =>
        locks.withLock(input.sessionID)(
          Effect.gen(function* () {
            const message = {
              id: SessionMessage.ID.make(
                `msg_shell_notice_${Hash.sha256(`${input.sessionID}\0${input.shellID}`).slice(0, 24)}`,
              ),
              sessionID: input.sessionID,
              text: input.text,
              description: input.description,
              metadata: input.metadata,
            }
            const row = yield* task(input.sessionID)
            const admitted = yield* sessions.synthetic({ ...message, resume: false })
            if (!input.resume || (row && row.state !== "running" && row.state !== "completed")) return admitted
            const pending = db
              .select({ id: SessionPendingTable.id })
              .from(SessionPendingTable)
              .where(and(eq(SessionPendingTable.id, message.id), eq(SessionPendingTable.session_id, input.sessionID)))
              .get()
              .pipe(Effect.orDie)
            if (!(yield* pending) || (yield* sessions.get(input.sessionID)).revert) return admitted
            if (row?.state !== "completed") {
              yield* execution.wake(input.sessionID)
              if (!row) return admitted
              if ((yield* task(input.sessionID))?.state !== "completed" || !(yield* pending)) return admitted
            }
            if ((yield* SessionReviewFold.fold(db, [input.sessionID])).some(SessionReviewFold.isOpen)) return admitted
            yield* publish(input.sessionID, { type: "started" })
            yield* execution.wake(input.sessionID)
            return admitted
          }),
        ),
      ),
      resume: Effect.fn("SessionOrchestration.resume")((input) =>
        locks.withLock(input.childID)(
          Effect.gen(function* () {
            const row = yield* owned(input.parentID, input.childID)
            if (row.state !== "running" && row.state !== "starting")
              return yield* new ConflictError({ message: `Cannot resume task in ${row.state}` })
            const pending = yield* db
              .select({ id: SessionPendingTable.id })
              .from(SessionPendingTable)
              .where(eq(SessionPendingTable.session_id, input.childID))
              .limit(1)
              .get()
              .pipe(Effect.orDie)
            if (!pending) return yield* new ConflictError({ message: `No durable pending work for ${input.childID}` })
            yield* execution.wake(input.childID)
            return (yield* withReviewState(db, [taskFromRow(row)]))[0]!
          }),
        ),
      ),
      progress: Effect.fn("SessionOrchestration.progress")((childID, text) =>
        locks.withLock(childID)(
          Effect.gen(function* () {
            const row = yield* task(childID)
            if (!row) return yield* new TaskNotFoundError({ childID })
            if (row.state !== "running")
              return yield* new ConflictError({ message: `Cannot report progress in ${row.state}` })
            yield* publish(childID, {
              type: "progressed",
              progress: { text: truncateUtf8(text, 4 * 1024), time: Date.now() },
            })
            return yield* current(childID)
          }),
        ),
      ),
      question: Effect.fn("SessionOrchestration.question")((childID, text, data) =>
        locks.withLock(childID)(
          Effect.gen(function* () {
            const row = yield* task(childID)
            if (!row) return yield* new TaskNotFoundError({ childID })
            if (row.state !== "running" || row.question_id !== null)
              return yield* new ConflictError({ message: `Cannot ask a question in ${row.state}` })
            const question = Question.make({
              id: QuestionID.make(`qst_${Hash.sha256(`${childID}\0${row.revision}\0${text}`).slice(0, 24)}`),
              text: truncateUtf8(text, 8 * 1024),
              data,
              time: Date.now(),
            })
            const snapshot = yield* autonomy
              .snapshot(childID, { inherited: true })
              .pipe(Effect.mapError(() => new TaskNotFoundError({ childID })))
            const mode = yield* DecisionChoice.decisionMode(autonomy, childID, "answers")
            const autoAnswer = mode === "auto"
            const yolo = mode === "yolo"
            const asleep = yield* autonomy
              .isAsleep(childID)
              .pipe(Effect.mapError(() => new TaskNotFoundError({ childID })))
            const child = yield* sessions.get(childID).pipe(
              Effect.mapError(() => new TaskNotFoundError({ childID })),
            )
            const entries = yield* Config.Service.pipe(
              Effect.provide(locations.get(child.location)),
              Effect.flatMap((config) => config.entries()),
            )
            const settled: SleepAnswerOutcome | undefined = autoAnswer || yolo
              ? yield* sleepAnswer({ childID, text, data, autoAnswer, yolo, questionID: question.id })
              : asleep
                ? { type: "defer" as const, reason: "disabled" as const }
                : undefined
            const applicable = settled?.type === "answer" && (yield* DecisionChoice.autonomyUnchanged(autonomy, childID, snapshot))
            const sleepOutcome: SleepAnswerOutcome | undefined = applicable
              ? settled
              : (yield* autonomy.isAsleep(childID).pipe(Effect.mapError(() => new TaskNotFoundError({ childID }))))
                ? settled?.type === "defer" ? settled : { type: "defer", reason: "disabled" }
                : undefined
            if (sleepOutcome?.type === "defer") {
              const limit = Config.latest(entries, "guardrails")?.max_pending_reviews ?? 16
              yield* SessionReviewFold.open(db, events, {
                sessionID: childID,
                kind: "subagent_question",
                reason: sleepOutcome.reason,
                ...(sleepOutcome.choice === undefined ? {} : { choice: sleepOutcome.choice }),
                ...(sleepOutcome.confidence === undefined ? {} : { confidence: sleepOutcome.confidence }),
                origin: { questionID: question.id },
                payload: { type: "subagent_question", text: question.text, ...(data === undefined ? {} : { data }) },
                limit,
              }).pipe(
                Effect.catchTag("SessionReview.FullError", () =>
                  Effect.fail(new ConflictError({ message: "the user's review box is full" })),
                ),
              )
              const deferredQuestion = Question.make({ ...question, deferred: true })
              yield* publish(childID, { type: "question_asked", question: deferredQuestion })
              return { question: deferredQuestion, autoAnswered: false }
            }
            if (sleepOutcome?.type === "answer") {
              const answerText = sleepOutcome.text
              yield* sessions
                .synthetic({
                  id: SessionOrchestrationIdentity.launch(
                    row.parent_id,
                    row.parent_assistant_message_id,
                    row.tool_call_id,
                  ).answer(question.id),
                  sessionID: childID,
                  causedBy: yield* SessionUsageAttribution.dispatch(db, childID),
                  text: `Parent answer:\n${JSON.stringify({
                    questionID: question.id,
                    text: answerText,
                  })}`,
                  description: "Autonomous subagent answer",
                  metadata: {
                    source: "subagent_parent",
                    parentID: row.parent_id,
                    childID,
                    kind: "answer",
                    questionID: question.id,
                    automatic: true,
                    via: sleepOutcome.confidence === undefined ? "auto-answer" : "yolo",
                    ...(sleepOutcome.confidence === undefined ? {} : { confidence: sleepOutcome.confidence }),
                  },
                  delivery: "steer",
                  resume: false,
                })
                .pipe(
                  Effect.mapError((error) =>
                    error._tag === "Session.NotFoundError"
                      ? new TaskNotFoundError({ childID })
                      : new ConflictError({ message: `Conflicting autonomous answer for ${question.id}` }),
                  ),
                )
              yield* execution.wake(childID)
              return { question, autoAnswered: true }
            }
            yield* publish(childID, { type: "question_asked", question })
            return { question, autoAnswered: false }
          }),
        ),
      ),
      settle: Effect.fn("SessionOrchestration.settle")((childID, settlement) =>
        locks.withLock(childID)(
          Effect.gen(function* () {
            const row = yield* task(childID)
            if (!row) return yield* new TaskNotFoundError({ childID })
            if (["cancelled", "completed", "failed", "lost"].includes(row.state)) return (yield* withReviewState(db, [taskFromRow(row)]))[0]!
            if (row.state !== "running")
              return yield* new ConflictError({ message: `Cannot settle task in ${row.state}` })
            yield* publish(
              childID,
              settlement.type === "failed"
                ? {
                    type: "failed",
                    error: failureText(settlement.error),
                    excerpt: settlement.excerpt ? truncateUtf8(settlement.excerpt, 16 * 1024) : undefined,
                  }
                : {
                    type: settlement.type,
                    excerpt: settlement.excerpt ? truncateUtf8(settlement.excerpt, 16 * 1024) : undefined,
                  },
            )
            return yield* current(childID)
          }),
        ),
      ),
      background: Effect.fn("SessionOrchestration.background")((childID) =>
        locks.withLock(childID)(
          Effect.gen(function* () {
            const row = yield* task(childID)
            if (!row) return yield* new TaskNotFoundError({ childID })
            if (row.background) return (yield* withReviewState(db, [taskFromRow(row)]))[0]!
            if (row.state !== "running")
              return yield* new ConflictError({ message: `Cannot background task in ${row.state}` })
            yield* publish(childID, { type: "backgrounded" })
            return yield* current(childID)
          }),
        ),
      ),
      teamView: Effect.fn("SessionOrchestration.teamView")(function* (parentID) {
        return (yield* readTeamView(db, parentID)) ?? renderTeamView([])
      }),
      recover: Effect.gen(function* () {
        const active = yield* db
          .select()
          .from(SessionTaskTable)
          .where(inArray(SessionTaskTable.state, ["starting", "running", "cancelling"]))
          .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.session_id))
          .all()
          .pipe(Effect.orDie)
        const terminal = yield* db
          .select({ session_id: SessionTaskTable.session_id })
          .from(SessionPendingTable)
          .innerJoin(SessionTaskTable, eq(SessionTaskTable.session_id, SessionPendingTable.session_id))
          .where(inArray(SessionTaskTable.state, ["cancelled", "completed", "failed", "lost"]))
          .groupBy(SessionTaskTable.session_id)
          .orderBy(asc(SessionTaskTable.time_created), asc(SessionTaskTable.session_id))
          .all()
          .pipe(Effect.orDie)
        const rows = [...active, ...terminal]
        yield* Effect.forEach(
          rows,
          (row) =>
            locks.withLock(row.session_id)(
              Effect.gen(function* () {
                const latest = yield* task(row.session_id)
                if (
                  !latest ||
                  (latest.state !== "starting" &&
                    latest.state !== "running" &&
                    latest.state !== "cancelling" &&
                    !isTerminal(latest.state))
                )
                  return
                if (latest.state === "cancelling") {
                  yield* publish(latest.session_id, { type: "cancelled" })
                  return
                }
                if (latest.state === "running" && latest.attempt_started) {
                  yield* publish(latest.session_id, {
                    type: "lost",
                    excerpt: "The child process ended during an in-flight model attempt. The attempt was not replayed.",
                  })
                  return
                }
                const pending = yield* db
                  .select({ id: SessionPendingTable.id })
                  .from(SessionPendingTable)
                  .where(eq(SessionPendingTable.session_id, latest.session_id))
                  .limit(1)
                  .get()
                  .pipe(Effect.orDie)
                if (isTerminal(latest.state)) {
                  if (!pending || (yield* SessionReviewFold.stoppedRecovery(db, latest.session_id)) !== undefined) return
                  yield* publish(latest.session_id, { type: "started" })
                  yield* execution.wake(latest.session_id)
                  return
                }
                if (!pending) {
                  if (latest.state === "starting") yield* publish(latest.session_id, { type: "started" })
                  yield* publish(latest.session_id, {
                    type: "lost",
                    excerpt:
                      "The child process ended without durable pending work. Provider execution was not replayed.",
                  })
                  return
                }
                if (latest.state === "starting") yield* publish(latest.session_id, { type: "started" })
                yield* execution.wake(latest.session_id)
              }),
            ),
          { concurrency: 4, discard: true },
        )
      }),
      resolveRecovery: Effect.fn("SessionOrchestration.resolveRecovery")((input) =>
        locks.withLock(input.childID)(
          Effect.gen(function* () {
            const row = yield* task(input.childID)
            if (!row) return yield* new TaskNotFoundError({ childID: input.childID })
            const item = (yield* SessionReviewFold.fold(db, [input.childID])).find((candidate) => candidate.itemID === input.itemID)
            if (!item || item.kind !== "recovery" || item.payload.type !== "recovery" || item.withdrawn !== undefined || !("questionID" in item.origin))
              return yield* new ConflictError({ message: `Review item ${input.itemID} is not an open restart recovery` })
            const questionID = item.origin.questionID
            const dots = input.dots
            if (dots?.target && (dots.target.itemID !== input.itemID || dots.target.fingerprint !== dots.fingerprint))
              return yield* new ConflictError({ message: "Dots recovery target does not match its review" })
            if (dots && (!dots.explicitDecision || SessionReviewFold.pendingFingerprint(item) !== dots.fingerprint || !(yield* dots.validate())))
              return yield* new ConflictError({ message: "Dots recovery authorization changed" })
            const stopped = SessionReviewFold.isStoppedRecovery(item)
            if (stopped ? input.choice !== "continue" || row.state !== "lost" : item.decision !== undefined || row.state !== "waiting" || row.question_id !== questionID)
              return yield* new ConflictError({ message: `Restart recovery ${input.itemID} cannot be decided in ${row.state}` })
            const tools = item.payload.tools.map((tool) => tool.name).join(", ")
            const decided = {
              definition: SessionEvent.Review.Decided,
              data: { sessionID: input.childID, itemID: input.itemID, decision: { kind: "recovery" as const, choice: input.choice }, ...(dots === undefined ? {} : { source: dots.source }) },
            }
            const receipt = dots === undefined ? [] : [{ definition: SessionEvent.DotsDecisionSettled, data: { sessionID: input.childID, source: dots.source,
              target: { kind: "review" as const, itemID: item.itemID, fingerprint: dots.fingerprint } } }]
            const actor = dots ? "The authenticated Dots client" : "The user"
            const inputID = SessionReviewFold.promptID(input.itemID)
            const unchanged = Effect.gen(function* () {
              const latest = yield* task(input.childID)
              if (latest?.revision !== row.revision || latest.state !== row.state) return false
              const owner = yield* db.select({ archived: SessionTable.time_archived }).from(SessionTable).where(eq(SessionTable.id, input.childID)).get().pipe(Effect.orDie)
              if (!owner || owner.archived !== null) return false
              const current = (yield* SessionReviewFold.fold(db, [input.childID])).find((candidate) => candidate.itemID === input.itemID)
              if (!current || current.withdrawn !== undefined || Hash.json(current.decision ?? null) !== Hash.json(item.decision ?? null)) return false
              if (dots && (!dots.explicitDecision || SessionReviewFold.pendingFingerprint(current) !== dots.fingerprint || !(yield* dots.validate()))) return false
              const admitted = yield* SessionPending.lookup(db, input.childID, inputID).pipe(
                Effect.catchDefect((defect) => defect instanceof SessionPending.LifecycleConflict ? Effect.succeed(false as const) : Effect.die(defect)),
              )
              return admitted === undefined
            })
            const committed = input.choice === "stop"
              ? yield* events.publishBatch([
                  { definition: SessionEvent.Task.Updated, data: { sessionID: input.childID, change: {
                    type: "lost",
                    excerpt: `${actor} stopped this subagent after a service restart interrupted ${tools}; their effects are unknown. ${dots ? "Explicit recovery authorization is required to continue it." : "Only the user can continue it."}`,
                    ...(dots === undefined ? {} : { source: dots.source }),
                  } } },
                  decided,
                  ...receipt,
                ], { when: unchanged })
              : yield* events.publishBatch([
                  { definition: SessionEvent.InputAdmitted, data: {
                    sessionID: input.childID,
                    inputID,
                    causedBy: yield* SessionUsageAttribution.dispatch(db, row.parent_id),
                    input: SessionPending.Message.make({
                      type: "synthetic",
                      data: {
                        text: `${actor} chose Continue after a service restart interrupted ${tools}. Their effects are unknown and they were not retried; check their results before repeating any of them.`,
                        description: "Restart recovery · continue",
                        metadata: { review: { itemID: input.itemID, kind: "recovery" }, ...(dots === undefined ? {} : { dotsSource: dots.source }) },
                      },
                      delivery: "steer",
                    }),
                  } },
                  { definition: SessionEvent.Task.Updated, data: { sessionID: input.childID, change: stopped
                    ? { type: "started" as const, ...(dots === undefined ? {} : { source: dots.source }) }
                    : { type: "question_answered" as const, answer: { questionID, text: "Continue", ...(dots === undefined ? {} : { source: dots.source }) } } } },
                  decided,
                  ...receipt,
                ], { when: unchanged })
            if (committed.length === 0)
              return yield* new ConflictError({ message: `Restart recovery ${input.itemID} changed before its decision` })
            if (input.choice === "continue") yield* execution.wake(input.childID)
            return yield* current(input.childID)
          }),
        ),
      ),
    }
    return result
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventRuntime.node,
    SessionAutonomy.node,
    SessionExecution.node,
    SessionStepBoundary.node,
    AppProcess.node,
    Session.node,
    LocationServiceMap.node,
  ],
})

function questionOptions(data: Schema.Json | undefined): string[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return []
  const options = (data as Record<string, unknown>).options
  if (!Array.isArray(options)) return []
  return options.flatMap((option) => {
    if (typeof option === "string") return [option]
    if (typeof option === "boolean") return [String(option)]
    if (option && typeof option === "object" && !Array.isArray(option)) {
      const label = (option as Record<string, unknown>).label
      const value = (option as Record<string, unknown>).value
      if (typeof label === "string") return [label]
      if (typeof value === "string") return [value]
      if (typeof value === "boolean") return [String(value)]
    }
    return []
  })
}
