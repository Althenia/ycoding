export * as SessionProjector from "./projector"

import { and, asc, desc, eq, gt, gte, inArray, lt, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { ModelV2 } from "../model"
import { SessionEvent } from "./event"
import { WorkspaceTable } from "../control-plane/workspace.sql"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionMessageUpdater } from "./message-updater"
import { SessionPending } from "./pending"
import { SessionPermissionCeiling } from "./permission-ceiling"
import { WorkspaceV2 } from "../workspace"
import { InstructionState } from "./instruction-state"
import {
  SessionPendingTable,
  SessionCompactionJobTable,
  SessionMessageTable,
  SessionFileChangeTable,
  SessionProviderRequestTable,
  SessionUsageTable,
  SessionTable,
  SessionTaskNotificationTable,
  SessionTaskTable,
  SessionContextStateTable,
} from "./sql"
import { EventTable } from "../event/sql"
import { Money } from "@ycoding-ai/schema/money"
import { SessionOrchestration } from "@ycoding-ai/schema/session-orchestration"
import { SessionContextState } from "./context-state"

type DatabaseService = Database.Interface["db"]
type CurrentDurableEvent = Extract<SessionEvent.Event, { readonly durable: object }>
type LegacyCompactionEvent =
  | typeof SessionEvent.Compaction.AdmittedV1.Type
  | typeof SessionEvent.Compaction.StartedV1.Type
  | typeof SessionEvent.Compaction.EndedV1.Type
  | typeof SessionEvent.Compaction.FailedV1.Type
type MessageEvent =
  | Exclude<
      CurrentDurableEvent,
      | typeof SessionEvent.Created.Type
      | typeof SessionEvent.Forked.Type
      | typeof SessionEvent.Deleted.Type
      | typeof SessionEvent.InstructionsUpdated.Type
      | typeof SessionEvent.Task.Updated.Type
      | typeof SessionEvent.ProviderRequestRecorded.Type
      | typeof SessionEvent.FileChange.Recorded.Type
      | typeof SessionEvent.Compaction.Replaced.Type
      | typeof SessionEvent.Compaction.Admitted.Type
      | typeof SessionEvent.Compaction.Started.Type
      | typeof SessionEvent.Compaction.Ended.Type
      | typeof SessionEvent.Compaction.Failed.Type
    >
  | LegacyCompactionEvent

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

const ForkBatchSize = 500

const forkTitle = (value: string) => {
  const match = value.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) return `${match[1]} (fork #${Number.parseInt(match[2], 10) + 1})`
  return `${value} (fork #1)`
}

function applyUsage(db: DatabaseService, sessionID: SessionSchema.ID, value: Usage, sign = 1) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost * sign}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input * sign}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output * sign}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning * sign}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read * sign}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write * sign}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

const publishSessionUsage = Effect.fn("SessionProjector.publishUsage")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  sessionID: (typeof SessionEvent.Step.Ended.Type)["data"]["sessionID"],
) {
  const row = yield* db
    .select({
      cost: SessionTable.cost,
      input: SessionTable.tokens_input,
      output: SessionTable.tokens_output,
      reasoning: SessionTable.tokens_reasoning,
      cacheRead: SessionTable.tokens_cache_read,
      cacheWrite: SessionTable.tokens_cache_write,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  yield* events.publish(SessionEvent.UsageUpdated, {
    sessionID,
    cost: Money.USD.make(row.cost),
    tokens: {
      input: row.input,
      output: row.output,
      reasoning: row.reasoning,
      cache: { read: row.cacheRead, write: row.cacheWrite },
    },
  })
})

const projectFork = Effect.fn("SessionProjector.projectFork")(function* (
  db: DatabaseService,
  event: typeof SessionEvent.Forked.Type,
) {
  const parent = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, event.data.parentID))
    .get()
    .pipe(Effect.orDie)
  if (!parent) return yield* Effect.die(new Error(`Fork parent session not found: ${event.data.parentID}`))
  const boundary = event.data.from
    ? yield* db
        .select({ seq: SessionMessageTable.seq })
        .from(SessionMessageTable)
        .where(
          and(eq(SessionMessageTable.session_id, event.data.parentID), eq(SessionMessageTable.id, event.data.from)),
        )
        .get()
        .pipe(Effect.orDie)
    : undefined
  if (event.data.from && !boundary)
    return yield* Effect.die(new Error(`Fork boundary message not found: ${event.data.from}`))
  const copied = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.parentID),
        boundary === undefined ? undefined : lt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const copiedSeq = copied?.seq

  const stored = yield* db
    .insert(SessionTable)
    .values({
      id: event.data.sessionID,
      parent_id: null,
      fork_session_id: event.data.parentID,
      fork_message_id: event.data.from,
      fork_seq: event.data.parentSeq,
      project_id: parent.project_id,
      workspace_id: parent.workspace_id,
      directory: parent.directory,
      path: parent.path,
      title: forkTitle(parent.title),
      agent: parent.agent,
      model: parent.model,
      permission: SessionPermissionCeiling.denyOnly(parent.permission ?? undefined),
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: DateTime.toEpochMillis(event.created),
      time_updated: DateTime.toEpochMillis(event.created),
    })
    .onConflictDoNothing()
    .returning({ sessionID: SessionTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new SessionAlreadyProjected())

  let cursor = -1
  while (copiedSeq !== undefined) {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, event.data.parentID),
          gt(SessionMessageTable.seq, cursor),
          lt(SessionMessageTable.seq, copiedSeq + 1),
          sql`${SessionMessageTable.type} != 'compaction' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
        ),
      )
      .orderBy(asc(SessionMessageTable.seq))
      .limit(ForkBatchSize)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) break

    const idMap = new Map(rows.map((row) => [row.id, SessionMessage.ID.create()]))
    yield* db
      .insert(SessionMessageTable)
      .values(
        rows.map((row) => {
          const id = idMap.get(row.id)
          if (!id) throw new Error(`Fork message ID mapping missing: ${row.id}`)
          return {
            id,
            session_id: event.data.sessionID,
            type: row.type,
            seq: row.seq,
            time_created: row.time_created,
            time_updated: row.time_updated,
            data: row.data,
          }
        }),
      )
      .run()
      .pipe(Effect.orDie)

    const pendingRows = yield* db
      .select()
      .from(SessionPendingTable)
      .where(
        and(
          eq(SessionPendingTable.session_id, event.data.parentID),
          inArray(
            SessionPendingTable.id,
            rows.map((row) => row.id),
          ),
        ),
      )
      .all()
      .pipe(Effect.orDie)
    if (pendingRows.length > 0) {
      yield* db
        .insert(SessionPendingTable)
        .values(
          pendingRows.flatMap((row) => {
            const id = idMap.get(row.id)
            return id && row.type !== "compaction"
              ? [
                  {
                    id,
                    session_id: event.data.sessionID,
                    type: row.type,
                    data: row.data,
                    delivery: row.delivery,
                    admitted_seq: row.admitted_seq,
                    time_created: row.time_created,
                  },
                ]
              : []
          }),
        )
        .run()
        .pipe(Effect.orDie)
    }

    cursor = rows.at(-1)!.seq
  }
  yield* EventV2.reserveSequence(db, event.data.sessionID, event.data.parentSeq)
  yield* SessionContextState.initialize(db, event.data.sessionID, DateTime.toEpochMillis(event.created))
  yield* InstructionState.rebuild(db, event.data.sessionID)
})

function run(db: DatabaseService, event: MessageEvent) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Info) => {
      if (event.durable === undefined)
        return Effect.die(new Error("Durable Session event is missing aggregate sequence"))
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Info) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getModel() {
        return db
          .select({ model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => (row?.model ? Schema.decodeUnknownSync(ModelV2.Ref)(row.model) : undefined)),
          )
      },
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer step supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          if (message.type !== "assistant") return
          if (!message.time.completed) return message
          // Succeeded executions complete the assistant before the terminal event clears `retry`;
          // still surface the completed row when it carries a pending retry so the header can
          // clear and reset to `ready` (next failure must start at attempt 1).
          if (message.retry) return message
          return undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getUser(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "user"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "user" ? message : undefined
        })
      },
      getSkillActivation(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(and(eq(SessionMessageTable.id, messageID), eq(SessionMessageTable.session_id, event.data.sessionID)))
            .get()
            .pipe(Effect.orDie)
          if (!row) return undefined
          const message = decodeRow(row)
          return message.type === "skill" || message.type === "assistant" ? message : undefined
        })
      },
      getShell(shellID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "shell"),
                sql`json_extract(${SessionMessageTable.data}, '$.shellID') = ${shellID}`,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "shell" ? message : undefined
        })
      },
      getCompaction() {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "compaction"),
                sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "compaction" ? message : undefined
        })
      },
      updateAssistant: updateMessage,
      updateUser: updateMessage,
      updateSkillActivation: updateMessage,
      updateShell: updateMessage,
      updateCompaction: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.DurableEvent, message: SessionMessage.Info) {
  if (event.durable === undefined) return Effect.die(new Error("Durable Session event is missing aggregate sequence"))
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

const currentCompactionMessage = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  jobID: string,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        sql`json_extract(${SessionMessageTable.data}, '$.jobID') = ${jobID}`,
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
  return message.type === "compaction" && "jobID" in message ? message : undefined
})

function storeCurrentCompaction(
  db: DatabaseService,
  event: SessionEvent.DurableEvent,
  message: SessionMessage.Compaction,
  update: boolean,
) {
  if (!update) return insertMessage(db, event, message)
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .update(SessionMessageTable)
    .set({ type, time_created: DateTime.toEpochMillis(message.time.created), data })
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.sessionID),
        eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
      ),
    )
    .run()
    .pipe(Effect.orDie)
}

const projectCurrentCompaction = Effect.fnUntraced(function* (
  db: DatabaseService,
  event: typeof SessionEvent.Compaction.Admitted.Type | typeof SessionEvent.Compaction.Started.Type,
  status: "pending" | "running",
) {
  const job = yield* db
    .select({ trigger: SessionCompactionJobTable.trigger, timeCreated: SessionCompactionJobTable.time_created })
    .from(SessionCompactionJobTable)
    .where(eq(SessionCompactionJobTable.id, event.data.jobID))
    .get()
    .pipe(Effect.orDie)
  if (!job) return
  const current = yield* currentCompactionMessage(db, event.data.sessionID, event.data.jobID)
  const base = {
    id: current?.id ?? SessionMessage.ID.fromEvent(event.id),
    type: "compaction" as const,
    jobID: event.data.jobID,
    trigger: job.trigger,
    metadata: current?.metadata ?? event.metadata,
    time: current?.time ?? { created: DateTime.makeUnsafe(job.timeCreated) },
  }
  const message =
    status === "pending"
      ? SessionMessage.CompactionPending.make({ ...base, status })
      : SessionMessage.CompactionRunningCurrent.make({ ...base, status })
  yield* storeCurrentCompaction(db, event, message, current !== undefined)
})

class TaskProjectionConflict extends Error {}

const incrementOrchestrationRevision = (db: DatabaseService, parentID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const updated = yield* db
      .update(SessionTable)
      .set({
        orchestration_revision: sql`${SessionTable.orchestration_revision} + 1`,
        time_updated: sql`${SessionTable.time_updated}`,
      })
      .where(eq(SessionTable.id, parentID))
      .returning({ parentID: SessionTable.id })
      .get()
      .pipe(Effect.orDie)
    if (!updated) return yield* Effect.die(new TaskProjectionConflict(`Task parent does not exist: ${parentID}`))
  })

const projectTask = Effect.fn("SessionProjector.projectTask")(function* (
  db: DatabaseService,
  event: typeof SessionEvent.Task.Updated.Type,
) {
  const change = event.data.change
  const time = DateTime.toEpochMillis(event.created)
  if (change.type === "launched") {
    const stored = yield* db
      .insert(SessionTaskTable)
      .values({
        session_id: event.data.sessionID,
        parent_id: change.parentID,
        parent_assistant_message_id: change.parentAssistantMessageID,
        tool_call_id: change.toolCallID,
        input_id: change.inputID,
        description: change.description,
        agent: change.agent,
        model: change.model,
        prompt_digest: change.promptDigest,
        background: change.background,
        delivery: change.delivery,
        state: "starting",
        attempt_started: false,
        revision: 0,
        time_created: time,
        time_updated: time,
      })
      .onConflictDoNothing()
      .returning({ sessionID: SessionTaskTable.session_id })
      .get()
      .pipe(Effect.orDie)
    if (!stored) return yield* Effect.die(new TaskProjectionConflict("Task launch identity already exists"))
    yield* incrementOrchestrationRevision(db, change.parentID)
    return
  }

  const task = yield* db
    .select()
    .from(SessionTaskTable)
    .where(eq(SessionTaskTable.session_id, event.data.sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!task) return yield* Effect.die(new TaskProjectionConflict("Task does not exist"))
  const revision = task.revision + 1
  const update = (value: Partial<typeof SessionTaskTable.$inferInsert>) =>
    Effect.gen(function* () {
      const stored = yield* db
        .update(SessionTaskTable)
        .set({ ...value, revision, time_updated: time })
        .where(and(eq(SessionTaskTable.session_id, event.data.sessionID), eq(SessionTaskTable.revision, task.revision)))
        .returning({ sessionID: SessionTaskTable.session_id })
        .get()
        .pipe(Effect.orDie)
      if (!stored) return yield* Effect.die(new TaskProjectionConflict("Task revision changed during projection"))
      yield* incrementOrchestrationRevision(db, task.parent_id)
    })
  const notify = (type: SessionOrchestration.NotificationType, excerpt?: string) =>
    db
      .insert(SessionTaskNotificationTable)
      .values({
        id: `ntf_${event.data.sessionID}_${revision}_${type}`,
        task_session_id: event.data.sessionID,
        parent_id: task.parent_id,
        type,
        revision,
        excerpt,
        delivered: false,
        time_created: time,
      })
      .run()
      .pipe(Effect.orDie)
  const detached = () =>
    task.background
      ? Effect.succeed(true)
      : db
          .select({ id: SessionTaskNotificationTable.id })
          .from(SessionTaskNotificationTable)
          .where(
            and(
              eq(SessionTaskNotificationTable.task_session_id, event.data.sessionID),
              eq(SessionTaskNotificationTable.type, "question"),
            ),
          )
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => row !== undefined),
          )
  const conflict = () => Effect.die(new TaskProjectionConflict(`Invalid ${change.type} transition from ${task.state}`))

  if (change.type === "started") {
    if (task.state === "starting") {
      yield* update({ state: "running" })
      return
    }
    if (!["cancelled", "completed", "failed", "lost"].includes(task.state)) return yield* conflict()
    yield* update({
      state: "running",
      progress: null,
      progress_time: null,
      question_id: null,
      question: null,
      question_data: null,
      question_time: null,
      attempt_started: false,
    })
    return
  }
  if (change.type === "backgrounded") {
    if (task.state !== "running" || task.background) return yield* conflict()
    yield* update({ background: true })
    return
  }
  if (change.type === "progressed") {
    if (task.state !== "running") return yield* conflict()
    yield* update({ progress: change.progress.text, progress_time: change.progress.time })
    return
  }
  if (change.type === "question_asked") {
    if (task.state !== "running" || task.question_id !== null) return yield* conflict()
    yield* update({
      state: "waiting",
      question_id: change.question.id,
      question: change.question.text,
      question_data: change.question.data,
      question_time: change.question.time,
    })
    yield* notify("question")
    return
  }
  if (change.type === "question_answered") {
    if (task.state !== "waiting" || task.question_id !== change.answer.questionID) return yield* conflict()
    yield* update({
      state: "running",
      question_id: null,
      question: null,
      question_data: null,
      question_time: null,
    })
    return
  }
  if (change.type === "cancel_requested") {
    if (task.state !== "starting" && task.state !== "running" && task.state !== "waiting") return yield* conflict()
    yield* update({ state: "cancelling" })
    return
  }
  if (change.type === "cancelled") {
    if (task.state !== "cancelling") return yield* conflict()
    yield* update({ state: "cancelled" })
    yield* notify("cancelled")
    return
  }
  if (change.type === "completed") {
    if (task.state !== "running") return yield* conflict()
    yield* update({ state: "completed" })
    if (yield* detached()) yield* notify("completed", change.excerpt)
    return
  }
  if (change.type === "failed") {
    if (task.state !== "running") return yield* conflict()
    yield* update({ state: "failed" })
    if (yield* detached())
      yield* notify("failed", change.excerpt ?? SessionOrchestration.truncateUtf8(change.error, 16 * 1024))
    return
  }
  if (task.state !== "running") return yield* conflict()
  yield* update({ state: "lost" })
  yield* notify("lost", change.excerpt)
})

const markTaskAttempt = (db: DatabaseService, sessionID: SessionSchema.ID, attemptStarted: boolean) =>
  db
    .update(SessionTaskTable)
    .set({ attempt_started: attemptStarted })
    .where(eq(SessionTaskTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    yield* events.project(SessionEvent.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values({
            id: event.data.sessionID,
            project_id: event.data.projectID,
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            parent_id: event.data.parentID,
            directory: event.data.location.directory,
            path: event.data.subpath,
            title: event.data.title,
            agent: event.data.agent,
            model: event.data.model,
            permission:
              event.data.permissionCeiling && event.data.permissionCeiling.length > 0
                ? SessionPermissionCeiling.denyOnly(event.data.permissionCeiling)
                : undefined,
            cost: 0,
            tokens_input: 0,
            tokens_output: 0,
            tokens_reasoning: 0,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
            time_created: event.data.created,
            time_updated: event.data.created,
          })
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
        yield* SessionContextState.initialize(db, event.data.sessionID, event.data.created)
        if (event.data.location.workspaceID) {
          yield* db
            .update(WorkspaceTable)
            .set({ time_used: Date.now() })
            .where(eq(WorkspaceTable.id, event.data.location.workspaceID))
            .run()
            .pipe(Effect.orDie)
        }
      }),
    )
    yield* events.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subpath,
            ...(event.data.projectID ? { project_id: event.data.projectID } : {}),
            workspace_id: event.data.location.workspaceID ? WorkspaceV2.ID.make(event.data.location.workspaceID) : null,
            time_updated: DateTime.toEpochMillis(event.created),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* InstructionState.reset(db, event.data.sessionID)
      }),
    )
    yield* events.project(SessionEvent.Deleted, (event) =>
      Effect.gen(function* () {
        const task = yield* db
          .select({ parentID: SessionTaskTable.parent_id })
          .from(SessionTaskTable)
          .where(eq(SessionTaskTable.session_id, event.data.sessionID))
          .get()
          .pipe(Effect.orDie)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie)
        if (task) yield* incrementOrchestrationRevision(db, task.parentID)
      }),
    )
    yield* events.project(SessionEvent.AgentSelected, (event) =>
      db
        .update(SessionTable)
        .set({ agent: event.data.agent, time_updated: DateTime.toEpochMillis(event.created) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.andThen(run(db, event))),
    )
    yield* events.project(SessionEvent.ModelSelected, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: DateTime.toEpochMillis(event.created) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.Renamed, (event) =>
      db
        .update(SessionTable)
        .set({ title: event.data.title, time_updated: DateTime.toEpochMillis(event.created) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* events.project(SessionEvent.UsageRecorded, (event) => applyUsage(db, event.data.sessionID, event.data))
    yield* events.project(SessionEvent.ProviderRequestRecorded, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionProviderRequestTable)
          .values({
            id: event.data.id,
            session_id: event.data.sessionID,
            input_id: event.data.inputID,
            source: event.data.source,
            agent: event.data.agent,
            model: event.data.model,
            route_id: event.data.routeID,
            prompt_cache_key: event.data.promptCacheKey,
            system_digest: event.data.systemDigest,
            tool_digest: event.data.toolDigest,
            request: event.data.request,
            attempts: event.data.attempts,
            invalidation: event.data.invalidation,
            continuation: event.data.continuation,
            cache_read_reported: event.data.cacheReadReported,
            cost: event.data.cost,
            tokens: event.data.tokens,
            time_created: DateTime.toEpochMillis(event.data.time),
          })
          .onConflictDoNothing()
          .returning({ id: SessionProviderRequestTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return
        yield* db
          .insert(SessionUsageTable)
          .values({
            session_id: event.data.sessionID,
            model_key: JSON.stringify([event.data.model.providerID, event.data.model.id, event.data.model.variant]),
            model: event.data.model,
            logical: 1,
            physical: event.data.attempts,
            helpers: event.data.source === "step" ? 0 : 1,
            continued: event.data.continuation === "continued" ? 1 : 0,
            fallback: event.data.continuation === "fallback" ? 1 : 0,
            cost: event.data.cost ?? null,
            input: event.data.tokens.input,
            output: event.data.tokens.output,
            reasoning: event.data.tokens.reasoning,
            cache_read: event.data.tokens.cache.read,
            cache_write: event.data.tokens.cache.write,
          })
          .onConflictDoUpdate({
            target: [SessionUsageTable.session_id, SessionUsageTable.model_key],
            set: {
              logical: sql`${SessionUsageTable.logical} + 1`,
              physical: sql`${SessionUsageTable.physical} + ${event.data.attempts}`,
              helpers: sql`${SessionUsageTable.helpers} + ${event.data.source === "step" ? 0 : 1}`,
              continued: sql`${SessionUsageTable.continued} + ${event.data.continuation === "continued" ? 1 : 0}`,
              fallback: sql`${SessionUsageTable.fallback} + ${event.data.continuation === "fallback" ? 1 : 0}`,
              cost:
                event.data.cost === undefined
                  ? null
                  : sql`case when ${SessionUsageTable.cost} is null then null else ${SessionUsageTable.cost} + ${event.data.cost} end`,
              input: sql`${SessionUsageTable.input} + ${event.data.tokens.input}`,
              output: sql`${SessionUsageTable.output} + ${event.data.tokens.output}`,
              reasoning: sql`${SessionUsageTable.reasoning} + ${event.data.tokens.reasoning}`,
              cache_read: sql`${SessionUsageTable.cache_read} + ${event.data.tokens.cache.read}`,
              cache_write: sql`${SessionUsageTable.cache_write} + ${event.data.tokens.cache.write}`,
            },
          })
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.Forked, (event) => projectFork(db, event))
    yield* events.project(SessionEvent.InputPromoted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined)
          return yield* Effect.die(new Error("Durable Session event is missing aggregate sequence"))
        const input = yield* SessionPending.projectPromoted(db, {
          id: event.data.inputID,
          sessionID: event.data.sessionID,
        })
        yield* insertMessage(
          db,
          event,
          input.type === "user"
            ? {
                id: input.id,
                type: "user",
                metadata: input.data.metadata,
                text: input.data.text,
                files: input.data.files,
                agents: input.data.agents,
                time: { created: event.created },
              }
            : {
                id: input.id,
                type: "synthetic",
                text: input.data.text,
                description: input.data.description,
                metadata: input.data.metadata,
                time: { created: event.created },
              },
        )
      }),
    )
    yield* events.project(SessionEvent.InputAdmitted, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined)
          return yield* Effect.die(new Error("Durable Session event is missing aggregate sequence"))
        yield* SessionPending.projectAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.inputID,
          sessionID: event.data.sessionID,
          input: event.data.input,
          timeCreated: event.created,
        })
      }),
    )
    yield* events.project(SessionEvent.InputConsumed, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.AdmittedV1, (event) =>
      Effect.gen(function* () {
        if (event.durable === undefined)
          return yield* Effect.die(new Error("Durable Session event is missing aggregate sequence"))
        yield* SessionPending.projectCompactionAdmitted(db, {
          admittedSeq: event.durable.seq,
          id: event.data.inputID,
          sessionID: event.data.sessionID,
          timeCreated: event.created,
        })
      }),
    )
    yield* events.project(SessionEvent.Execution.Succeeded, (event) => run(db, event))
    yield* events.project(SessionEvent.Execution.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.Execution.Interrupted, (event) => run(db, event))
    yield* events.project(SessionEvent.InstructionsUpdated, (event) =>
      InstructionState.apply(db, event.data.sessionID, event.durable.seq, event.data.delta),
    )
    yield* events.project(SessionEvent.Task.Updated, (event) => projectTask(db, event))
    yield* events.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* events.project(SessionEvent.Skill.Activated, (event) => run(db, event))
    yield* events.project(SessionEvent.Skill.Deactivated, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Step.Started, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* markTaskAttempt(db, event.data.sessionID, true)
      }),
    )
    yield* events.project(SessionEvent.Step.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* markTaskAttempt(db, event.data.sessionID, false)
        yield* applyUsage(db, event.data.sessionID, event.data)
      }),
    )
    yield* events.project(SessionEvent.Step.Failed, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* markTaskAttempt(db, event.data.sessionID, false)
        if (event.data.cost !== undefined && event.data.tokens !== undefined)
          yield* applyUsage(db, event.data.sessionID, { cost: event.data.cost, tokens: event.data.tokens })
      }),
    )
    yield* events.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Progress, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* events.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* events.project(SessionEvent.FileChange.Recorded, (event) => {
      if (event.durable === undefined)
        return Effect.die(new Error("Durable Session event is missing aggregate sequence"))
      return db
        .insert(SessionFileChangeTable)
        .values({
          session_id: event.data.sessionID,
          path: event.data.change.path,
          patch: event.data.change.patch,
          additions: event.data.change.additions,
          deletions: event.data.change.deletions,
          latest_seq: event.durable.seq,
        })
        .onConflictDoUpdate({
          target: [SessionFileChangeTable.session_id, SessionFileChangeTable.path],
          set: {
            patch: event.data.change.patch,
            additions: sql`${SessionFileChangeTable.additions} + ${event.data.change.additions}`,
            deletions: sql`${SessionFileChangeTable.deletions} + ${event.data.change.deletions}`,
            latest_seq: event.durable.seq,
          },
        })
        .run()
        .pipe(Effect.orDie)
    })
    yield* events.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* events.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    yield* events.project(SessionEvent.RetryScheduled, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.Admitted, (event) => projectCurrentCompaction(db, event, "pending"))
    yield* events.project(SessionEvent.Compaction.Started, (event) => projectCurrentCompaction(db, event, "running"))
    yield* events.project(SessionEvent.Compaction.StartedV1, (event) => run(db, event))
    yield* events.project(SessionEvent.Compaction.EndedV1, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* InstructionState.advanceEpoch(db, event.data.sessionID, event.durable.seq)
        if (event.durable === undefined)
          return yield* Effect.die(new Error("Durable Session event is missing aggregate sequence"))
        if (event.data.reason === "manual")
          yield* SessionPending.settleCompaction(db, { sessionID: event.data.sessionID })
      }),
    )
    yield* events.project(SessionEvent.Compaction.Ended, (event) =>
      Effect.gen(function* () {
        const job = yield* db
          .select({ trigger: SessionCompactionJobTable.trigger, timeCreated: SessionCompactionJobTable.time_created })
          .from(SessionCompactionJobTable)
          .where(eq(SessionCompactionJobTable.id, event.data.jobID))
          .get()
          .pipe(Effect.orDie)
        if (job) {
          const current = yield* currentCompactionMessage(db, event.data.sessionID, event.data.jobID)
          yield* storeCurrentCompaction(
            db,
            event,
            SessionMessage.CompactionCompletedCurrent.make({
              id: current?.id ?? SessionMessage.ID.fromEvent(event.id),
              type: "compaction",
              jobID: event.data.jobID,
              trigger: job.trigger,
              status: "completed",
              revision: event.data.revision,
              boundary: event.data.boundary,
              metrics: event.data.metrics,
              metadata: current?.metadata ?? event.metadata,
              time: current?.time ?? { created: DateTime.makeUnsafe(job.timeCreated) },
            }),
            current !== undefined,
          )
        }
        yield* InstructionState.advanceEpoch(db, event.data.sessionID, event.durable.seq)
      }),
    )
    // Replacement is a durable transcript-reload signal. The committed summary already occupies
    // its historical boundary, so projecting this event must not append a second compaction row.
    yield* events.project(SessionEvent.Compaction.Replaced, () => Effect.void)
    yield* events.project(SessionEvent.Compaction.FailedV1, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        if (event.durable === undefined)
          return yield* Effect.die(new Error("Durable Session event is missing aggregate sequence"))
        if (event.data.reason === "manual")
          yield* SessionPending.settleCompaction(db, { sessionID: event.data.sessionID })
      }),
    )
    yield* events.project(SessionEvent.Compaction.Failed, (event) =>
      Effect.gen(function* () {
        const job = yield* db
          .select({ trigger: SessionCompactionJobTable.trigger, timeCreated: SessionCompactionJobTable.time_created })
          .from(SessionCompactionJobTable)
          .where(eq(SessionCompactionJobTable.id, event.data.jobID))
          .get()
          .pipe(Effect.orDie)
        if (!job) return
        const current = yield* currentCompactionMessage(db, event.data.sessionID, event.data.jobID)
        yield* storeCurrentCompaction(
          db,
          event,
          SessionMessage.CompactionFailedCurrent.make({
            id: current?.id ?? SessionMessage.ID.fromEvent(event.id),
            type: "compaction",
            jobID: event.data.jobID,
            trigger: job.trigger,
            status: "failed",
            code: event.data.code,
            error: event.data.error,
            metadata: current?.metadata ?? event.metadata,
            time: current?.time ?? { created: DateTime.makeUnsafe(job.timeCreated) },
          }),
          current !== undefined,
        )
      }),
    )
    yield* events.project(SessionEvent.RevertEvent.Staged, (event) =>
      Effect.gen(function* () {
        const revert = event.data.revert
        yield* db
          .update(SessionTable)
          .set({
            revert: { ...revert, files: revert.files ? [...revert.files] : undefined },
            time_updated: DateTime.toEpochMillis(event.created),
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* events.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: DateTime.toEpochMillis(event.created) })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* events.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.id, event.data.to)),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(new Error(`Revert boundary message not found: ${event.data.to}`))
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gte(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionPendingTable)
          .where(
            and(
              eq(SessionPendingTable.session_id, event.data.sessionID),
              gte(SessionPendingTable.admitted_seq, boundary.seq),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: DateTime.toEpochMillis(event.created) })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* InstructionState.reset(db, event.data.sessionID)
      }),
    )
    yield* events.subscribe([SessionEvent.Step.Ended, SessionEvent.Step.Failed, SessionEvent.UsageRecorded]).pipe(
      Stream.runForEach((event) => {
        if (
          event.type === SessionEvent.Step.Failed.type &&
          (event.data.cost === undefined || event.data.tokens === undefined)
        )
          return Effect.void
        return publishSessionUsage(db, events, event.data.sessionID)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

// Durable compaction boundary is read from SessionCompactionManifest (SessionContextState) and
// durable session.compaction.ended events. Must be queried on every fetch/switch, never cached.
export function latestCompactionBoundary(db: DatabaseService, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const ctx = yield* db
      .select({ seq: SessionContextStateTable.covered_through_seq })
      .from(SessionContextStateTable)
      .where(eq(SessionContextStateTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)
    const ctxSeq = (ctx?.seq as number | null | undefined) ?? undefined
    const normalizedCtxSeq = ctxSeq === null ? undefined : ctxSeq
    const eventRow = yield* db
      .select({ data: EventTable.data, seq: EventTable.seq })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), sql`${EventTable.type} LIKE 'session.compaction.ended%'`))
      .orderBy(desc(EventTable.seq))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    let eventSeq: number | undefined
    if (eventRow?.data && typeof eventRow.data === "object") {
      const d = eventRow.data as Record<string, unknown>
      const b = (d as { boundary?: { seq?: unknown } }).boundary
      if (b && typeof b.seq === "number") eventSeq = b.seq
      else if (typeof (d as { through?: unknown }).through === "number") eventSeq = (d as { through: number }).through
      else {
        const ct = (d as { coveredThrough?: { seq?: unknown } }).coveredThrough
        if (ct && typeof ct.seq === "number") eventSeq = ct.seq
      }
    }
    if (normalizedCtxSeq !== undefined && eventSeq !== undefined) return Math.max(normalizedCtxSeq, eventSeq)
    return normalizedCtxSeq ?? eventSeq
  })
}

export function selectTranscript(db: DatabaseService, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, sessionID))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const boundary: number | undefined = yield* latestCompactionBoundary(db, sessionID)
    const filtered = boundary === undefined ? rows : rows.filter((row) => row.seq > boundary)
    return filtered.map((row) => decodeMessage({ ...row.data, id: row.id, type: row.type }))
  })
}

// Convenience overload that fetches boundary via Database.Service for direct sessionID callers (session switch path).
export const selectTranscriptForSession = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* selectTranscript(db, sessionID)
  })

export const node = makeGlobalNode({ name: "session-projector", layer, deps: [EventV2.node, Database.node] })
