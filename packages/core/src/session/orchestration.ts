export * as SessionOrchestration from "./orchestration"

import type { Model } from "@ycoding-ai/schema/model"
import {
  Question,
  QuestionID,
  Task,
  TeamView,
  truncateUtf8,
  ListAnchor,
  type Change,
  type NotificationType,
  type State,
} from "@ycoding-ai/schema/session-orchestration"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { KeyedMutex } from "../effect/keyed-mutex"
import { PermissionV2 } from "../permission"
import { Hash } from "../util/hash"
import { canonicalJSON } from "./context-manifest"
import { Context, Effect, Layer, Schema } from "effect"
import { SqlError } from "effect/unstable/sql/SqlError"
import { and, asc, count, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm"
import { SessionV2 } from "../session"
import { SessionExecution } from "./execution"
import { SessionAutonomy } from "./autonomy"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionPermissionCeiling } from "./permission-ceiling"
import { SessionRunnerModel } from "./runner/model"
import { SessionSchema } from "./schema"
import { SessionPendingTable, SessionTable, SessionTaskTable } from "./sql"

const TeamViewBytes = 32 * 1024
const terminalStates = new Set<State>(["cancelled", "completed", "failed", "lost"])
const PageSize = 10
type DatabaseService = Database.Interface["db"]
export { truncateUtf8 }
export const failureText = (input: string) => truncateUtf8(input, 16 * 1024)

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
        if (!parent) return yield* new SessionV2.NotFoundError({ sessionID: input.parentID })

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
          ? previous
            ? or(
                lt(taskPriority, cursor.rank),
                and(eq(taskPriority, cursor.rank), gt(SessionTaskTable.time_updated, cursor.updated)),
                and(
                  eq(taskPriority, cursor.rank),
                  eq(SessionTaskTable.time_updated, cursor.updated),
                  lt(SessionTaskTable.session_id, cursor.sessionID),
                ),
              )
            : or(
                gt(taskPriority, cursor.rank),
                and(eq(taskPriority, cursor.rank), lt(SessionTaskTable.time_updated, cursor.updated)),
                and(
                  eq(taskPriority, cursor.rank),
                  eq(SessionTaskTable.time_updated, cursor.updated),
                  gt(SessionTaskTable.session_id, cursor.sessionID),
                ),
              )
          : undefined
        const rows = yield* db
          .select()
          .from(SessionTaskTable)
          .where(and(eq(SessionTaskTable.parent_id, input.parentID), boundary))
          .orderBy(
            previous ? desc(taskPriority) : asc(taskPriority),
            previous ? asc(SessionTaskTable.time_updated) : desc(SessionTaskTable.time_updated),
            previous ? desc(SessionTaskTable.session_id) : asc(SessionTaskTable.session_id),
          )
          .limit(limit + 1)
          .all()
          .pipe(Effect.orDie)
        const hasMore = rows.length > limit
        const data = (previous ? rows.slice(0, limit).toReversed() : rows.slice(0, limit)).map(taskFromRow)
        const first = data[0]
        const last = data.at(-1)
        const previousCursor =
          first && (previous ? hasMore : cursor !== undefined)
            ? ListAnchor.make({
                rank: taskRank(first.state),
                updated: first.time.updated,
                sessionID: first.sessionID,
                direction: "previous",
              })
            : undefined
        const nextCursor =
          last && (previous ? cursor !== undefined : hasMore)
            ? ListAnchor.make({
                rank: taskRank(last.state),
                updated: last.time.updated,
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
        if (!parent) return yield* new SessionV2.NotFoundError({ sessionID: parentID })
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

export const identities = (parentID: SessionSchema.ID, messageID: SessionMessage.ID, callID: string) => {
  const digest = Hash.sha256(`${parentID}\0${messageID}\0${callID}`)
  return {
    childID: SessionSchema.ID.make(`ses_task_${digest.slice(0, 24)}`),
    inputID: SessionMessage.ID.make(`msg_task_${digest.slice(0, 24)}`),
    launchEventID: `evt_task_${digest.slice(0, 24)}`,
    answer: (questionID: QuestionID) =>
      SessionMessage.ID.make(`msg_task_answer_${Hash.sha256(`${digest}\0${questionID}`).slice(0, 24)}`),
    notification: (revision: number, type: NotificationType) =>
      SessionMessage.ID.make(`msg_task_notice_${Hash.sha256(`${digest}\0${revision}\0${type}`).slice(0, 24)}`),
  }
}

export const renderTeamView = (tasks: ReadonlyArray<Task>, maxBytes = TeamViewBytes) => {
  const sorted = tasks
    .map(
      (task): Task => ({
        ...task,
        description: truncateUtf8(task.description, 4 * 1024),
        progress: task.progress ? { ...task.progress, text: truncateUtf8(task.progress.text, 4 * 1024) } : undefined,
        question: task.question ? { ...task.question, text: truncateUtf8(task.question.text, 8 * 1024) } : undefined,
      }),
    )
    .toSorted((a, b) => {
      const state = Number(terminalStates.has(a.state)) - Number(terminalStates.has(b.state))
      if (state !== 0) return state
      if (a.time.updated !== b.time.updated) return b.time.updated - a.time.updated
      return String(a.sessionID).localeCompare(String(b.sessionID))
    })
  const prefix =
    "Internal orchestration context (JSON). Use it to coordinate work. Do not surface subagent status unless the user explicitly asks; report a failure only when it blocks the requested outcome:\n"
  const children = new Array<Task>()
  for (const task of sorted) {
    const view = TeamView.make({
      children: [...children, task],
      omitted: sorted.length - children.length - 1,
    })
    if (Buffer.byteLength(prefix + JSON.stringify(view)) > maxBytes) break
    children.push(task)
  }
  const view = TeamView.make({ children, omitted: sorted.length - children.length })
  return { view, text: prefix + JSON.stringify(view) }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionOrchestration.NotFoundError", {
  parentID: SessionSchema.ID,
  childID: SessionSchema.ID,
}) {}

export class ForbiddenError extends Schema.TaggedErrorClass<ForbiddenError>()("SessionOrchestration.ForbiddenError", {
  parentID: SessionSchema.ID,
  childID: SessionSchema.ID,
}) {}

export class TaskNotFoundError extends Schema.TaggedErrorClass<TaskNotFoundError>()(
  "SessionOrchestration.TaskNotFoundError",
  { childID: SessionSchema.ID },
) {}

export class ConflictError extends Schema.TaggedErrorClass<ConflictError>()("SessionOrchestration.ConflictError", {
  message: Schema.String,
}) {}

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
) {}

export interface ModelSource {
  readonly agent: AgentV2.ID
  readonly messageID: SessionMessage.ID
  readonly callID: string
}

export interface LaunchInput {
  readonly parentID: SessionSchema.ID
  readonly parentAssistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly agent: AgentV2.ID
  readonly description: string
  readonly prompt: string
  readonly background: boolean
  readonly model?: Model.Ref
  readonly prepared: Prepared
}

export interface Prepared {
  readonly target: AgentV2.Info
  readonly caller: AgentV2.Info
  readonly resolved: SessionRunnerModel.Resolved
}

export const preflight = Effect.fn("SessionOrchestration.preflight")(function* (
  parent: SessionSchema.Info,
  input: { readonly agent: AgentV2.ID; readonly model?: Model.Ref; readonly caller?: AgentV2.ID },
) {
  const agents = yield* AgentV2.Service
  const target = yield* agents.resolve(input.agent)
  if (!target) return yield* new InvalidRequestError({ message: `Unknown agent: ${input.agent}` })
  if (target.mode === "primary")
    return yield* new InvalidRequestError({ message: `Agent ${input.agent} cannot run as a subagent` })
  const caller = yield* agents.resolve(input.caller ?? parent.agent)
  if (!caller) return yield* new InvalidRequestError({ message: "Parent agent is unavailable" })
  const models = yield* SessionRunnerModel.Service
  const resolved = yield* models
    .resolve({ ...parent, model: selectModel(input.model, target.model, parent.model) })
    .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))
  return { target, caller, resolved }
})

export const authorize = Effect.fn("SessionOrchestration.authorize")(function* (
  parentID: SessionSchema.ID,
  target: AgentV2.ID,
  source: ModelSource,
) {
  const permission = yield* PermissionV2.Service
  yield* permission.assert({
    action: "subagent",
    resources: [target],
    save: [target],
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
  ) => Effect.Effect<Task, SessionV2.NotFoundError | NotFoundError | ForbiddenError>
  readonly launch: (input: LaunchInput) => Effect.Effect<Task, LaunchError>
  readonly list: (parentID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Task>, SessionV2.NotFoundError>
  readonly page: (input: {
    readonly parentID: SessionSchema.ID
    readonly limit?: number
    readonly cursor?: ListAnchor
  }) => Effect.Effect<Page, SessionV2.NotFoundError>
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
  }) => Effect.Effect<Task, AnswerError>
  readonly cancel: (input: {
    readonly parentID: SessionSchema.ID
    readonly childID: SessionSchema.ID
  }) => Effect.Effect<Task, ControlError>
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
  ) => Effect.Effect<ReturnType<typeof renderTeamView>, SessionV2.NotFoundError>
  readonly recover: Effect.Effect<void>
}

export type Error =
  | SessionV2.NotFoundError
  | NotFoundError
  | TaskNotFoundError
  | ForbiddenError
  | ConflictError
  | InvalidRequestError
  | ServiceUnavailableError
  | QuestionNotFoundError
  | PermissionV2.Error

export type OwnershipError = SessionV2.NotFoundError | NotFoundError | ForbiddenError
export type LaunchError = SessionV2.NotFoundError | ConflictError | InvalidRequestError
export type ControlError = OwnershipError | ConflictError
export type AnswerError = ControlError | InvalidRequestError | QuestionNotFoundError

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SessionOrchestration") {}

const taskFromRow = (row: typeof SessionTaskTable.$inferSelect): Task =>
  Task.make({
    sessionID: row.session_id,
    parentID: row.parent_id,
    description: row.description,
    agent: AgentV2.ID.make(row.agent),
    model: row.model,
    background: row.background,
    state: row.state,
    progress:
      row.progress === null || row.progress_time === null ? undefined : { text: row.progress, time: row.progress_time },
    question:
      row.question_id === null || row.question === null || row.question_time === null
        ? undefined
        : { id: row.question_id, text: row.question, data: row.question_data ?? undefined, time: row.question_time },
    revision: row.revision,
    time: { created: row.time_created, updated: row.time_updated },
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const events = yield* EventV2.Service
    const execution = yield* SessionExecution.Service
    const sessions = yield* SessionV2.Service
    const autonomy = yield* SessionAutonomy.Service
    const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

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

    const publish = (childID: SessionSchema.ID, change: Change, id?: string) =>
      events.publish(
        SessionEvent.Task.Updated,
        { sessionID: childID, change },
        { id: id ? EventV2.ID.make(id) : undefined },
      )

    const current = Effect.fn("SessionOrchestration.current")(function* (childID: SessionSchema.ID) {
      const row = yield* task(childID)
      if (!row) return yield* Effect.die(new Error(`Projected task missing: ${childID}`))
      return taskFromRow(row)
    })

    const result: Interface = {
      managed: Effect.fn("SessionOrchestration.managed")(function* (childID) {
        return (yield* task(childID)) !== undefined
      }),
      get: Effect.fn("SessionOrchestration.get")(function* (parentID, childID) {
        return taskFromRow(yield* owned(parentID, childID))
      }),
      launch: Effect.fn("SessionOrchestration.launch")((input) => {
        const ids = identities(input.parentID, input.parentAssistantMessageID, input.toolCallID)
        return locks.withLock(ids.childID)(
          Effect.gen(function* () {
            const parent = yield* sessions.get(input.parentID)
            const prepared = input.prepared
            const promptDigest = Hash.sha256(input.prompt)
            const start = Effect.gen(function* () {
              yield* sessions
                .prompt({ id: ids.inputID, sessionID: ids.childID, text: input.prompt, resume: false })
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
            const existing = yield* task(ids.childID)
            if (existing) {
              if (
                existing.parent_id === input.parentID &&
                existing.agent === prepared.target.id &&
                existing.model.providerID === prepared.resolved.ref.providerID &&
                existing.model.id === prepared.resolved.ref.id &&
                (existing.model.variant ?? "default") === (prepared.resolved.ref.variant ?? "default") &&
                existing.prompt_digest === promptDigest &&
                existing.background === input.background &&
                existing.delivery === "steer"
              ) {
                if (existing.state === "starting") return yield* start
                return taskFromRow(existing)
              }
              return yield* new ConflictError({ message: `Conflicting launch retry for ${ids.childID}` })
            }
            yield* sessions.create({
              id: ids.childID,
              parentID: input.parentID,
              title: input.description,
              agent: prepared.target.id,
              model: prepared.resolved.ref,
              permissionCeiling: SessionPermissionCeiling.inherit(
                parent.permissionCeiling,
                prepared.caller.permissions,
              ),
            })
            yield* publish(
              ids.childID,
              {
                type: "launched",
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
        return rows.map(taskFromRow)
      }),
      page: Effect.fn("SessionOrchestration.page")((input) => page(db, input)),
      send: Effect.fn("SessionOrchestration.send")((input) =>
        locks.withLock(input.childID)(
          Effect.gen(function* () {
            const row = yield* owned(input.parentID, input.childID)
            if (row.state !== "running" && !terminalStates.has(row.state))
              return yield* new ConflictError({ message: `Cannot send to task in ${row.state}` })
            yield* sessions
              .synthetic({
                id: input.messageID,
                sessionID: input.childID,
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
            const pending = yield* db
              .select({ id: SessionPendingTable.id })
              .from(SessionPendingTable)
              .where(
                and(eq(SessionPendingTable.id, input.messageID), eq(SessionPendingTable.session_id, input.childID)),
              )
              .get()
              .pipe(Effect.orDie)
            if (terminalStates.has(row.state)) {
              if (!pending) return taskFromRow(row)
              yield* publish(input.childID, { type: "started" })
            }
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
            if (input.text === undefined && input.data === undefined)
              return yield* new InvalidRequestError({ message: "An answer requires text or data" })
            const id = identities(row.parent_id, row.parent_assistant_message_id, row.tool_call_id).answer(
              input.questionID,
            )
            yield* sessions
              .synthetic({
                id,
                sessionID: input.childID,
                text: `Parent answer:\n${JSON.stringify({ questionID: input.questionID, text: input.text, data: input.data })}`,
                description: "Parent subagent answer",
                metadata: {
                  source: "subagent_parent",
                  parentID: input.parentID,
                  childID: input.childID,
                  kind: "answer",
                  questionID: input.questionID,
                },
                delivery: "steer",
                resume: false,
              })
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "Session.NotFoundError"
                    ? error
                    : new ConflictError({ message: `Conflicting answer for ${input.questionID}` }),
                ),
              )
            yield* publish(input.childID, {
              type: "question_answered",
              answer: { questionID: input.questionID, text: input.text, data: input.data },
            })
            yield* execution.wake(input.childID)
            return yield* current(input.childID)
          }),
        ),
      ),
      cancel: Effect.fn("SessionOrchestration.cancel")((input) =>
        locks.withLock(input.childID)(
          Effect.gen(function* () {
            const row = yield* owned(input.parentID, input.childID)
            if (row.state === "cancelled") return taskFromRow(row)
            if (row.state !== "starting" && row.state !== "running" && row.state !== "waiting")
              return yield* new ConflictError({ message: `Cannot cancel task in ${row.state}` })
            yield* publish(input.childID, { type: "cancel_requested" })
            yield* execution.interrupt(input.childID)
            yield* publish(input.childID, { type: "cancelled" })
            return yield* current(input.childID)
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
            return taskFromRow(row)
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
            if (yield* autonomy.canAutoAnswer(childID).pipe(Effect.mapError(() => new TaskNotFoundError({ childID })))) {
              yield* sessions
                .synthetic({
                  id: identities(row.parent_id, row.parent_assistant_message_id, row.tool_call_id).answer(question.id),
                  sessionID: childID,
                  text: `Parent answer:\n${JSON.stringify({
                    questionID: question.id,
                    text: SessionAutonomy.AutomaticAnswer,
                  })}`,
                  description: "Autonomous subagent answer",
                  metadata: {
                    source: "subagent_parent",
                    parentID: row.parent_id,
                    childID,
                    kind: "answer",
                    questionID: question.id,
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
            if (["cancelled", "completed", "failed", "lost"].includes(row.state)) return taskFromRow(row)
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
            if (row.background) return taskFromRow(row)
            if (row.state !== "running")
              return yield* new ConflictError({ message: `Cannot background task in ${row.state}` })
            yield* publish(childID, { type: "backgrounded" })
            return yield* current(childID)
          }),
        ),
      ),
      teamView: Effect.fn("SessionOrchestration.teamView")(function* (parentID) {
        return renderTeamView(yield* result.list(parentID))
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
                    !terminalStates.has(latest.state))
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
                if (terminalStates.has(latest.state)) {
                  if (!pending) return
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
    }
    return result
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionAutonomy.node, SessionExecution.node, SessionV2.node],
})
