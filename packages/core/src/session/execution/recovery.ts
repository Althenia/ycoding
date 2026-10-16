export * as SessionTaskRecovery from "./recovery"

import { Question, QuestionID, truncateUtf8 } from "@ycoding-ai/schema/session-orchestration"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm"
import { Clock, Effect, Option, Schema, Scope } from "effect"
import type { Database } from "../../database/database"
import { EventRuntime } from "../../event"
import { EventTable } from "../../event/sql"
import type { AppProcess } from "../../process"
import { ShellLedger } from "../../shell/ledger"
import { Hash } from "../../util/hash"
import { SessionEvent } from "../event"
import type { SessionExecution } from "../execution"
import { SessionHistory } from "../history"
import { SessionMessage } from "../message"
import { SessionPending } from "../pending"
import { SessionReviewFold } from "../review-fold"
import { SessionSchema } from "../schema"
import { SessionTable, SessionTaskTable } from "../sql"

type Db = Database.Interface["db"]
type Row = typeof SessionTaskTable.$inferSelect
type Assistant = Extract<SessionMessage.Info, { readonly type: "assistant" }>
type ToolPart = Extract<Assistant["content"][number], { readonly type: "tool" }>

const versioned = (definition: Extract<EventRuntime.Definition, { durability: "durable" }>) =>
  EventRuntime.versionedType(definition.type, definition.durable.version)

const lifecycle = [
  SessionEvent.Execution.Started,
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
].map(versioned)

const notResumed = "The service restarted while the child task was active. Provider execution was not resumed."
const notResumedAgain =
  "The service restarted again before the recovered child task completed a step. Provider execution was not resumed."

type Input = {
  readonly db: Db
  readonly events: EventRuntime.Interface
  readonly appProcess: AppProcess.Interface
  readonly execution: SessionExecution.Interface
  readonly lifetime: Scope.Scope
}

export const recover = Effect.fn("SessionTaskRecovery.recover")(function* (input: Input) {
  const rows = yield* input.db
    .select()
    .from(SessionTaskTable)
    .where(inArray(SessionTaskTable.state, ["starting", "running", "waiting", "cancelling"]))
    .orderBy(asc(SessionTaskTable.session_id))
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) return
  const snapshot = yield* ShellLedger.processes(input.appProcess).pipe(Effect.option)
  if (Option.isNone(snapshot)) {
    yield* Effect.logWarning("could not list processes; active child tasks were not recovered")
    return
  }
  yield* Effect.forEach(
    rows.filter((row) => !ShellLedger.alive(snapshot.value, row.owner_pid, row.owner_started)),
    (row) => recoverTask(input, row),
    { discard: true },
  )
})

const recoverTask = Effect.fnUntraced(function* (input: Input, row: Row) {
  const db = input.db
  const events = input.events
  const sessionID = SessionSchema.ID.make(row.session_id)
  if (row.state === "waiting" && row.question_id !== null && row.question !== null && row.question_time !== null) return
  const unchanged = Effect.gen(function* () {
    const latest = yield* db.select().from(SessionTaskTable).where(eq(SessionTaskTable.session_id, row.session_id)).get().pipe(Effect.orDie)
    return (
      latest?.revision === row.revision &&
      latest.state === row.state &&
      latest.owner_pid === row.owner_pid &&
      latest.owner_started === row.owner_started
    )
  })
  const lose = (excerpt: string) =>
    events.publishBatch(
      [
        {
          definition: SessionEvent.Task.Updated,
          data: { sessionID, change: { type: "lost", excerpt } },
          options: { id: EventRuntime.ID.make(`evt_task_restart_lost_${row.session_id}_${row.revision + 1}`) },
        },
      ],
      { when: unchanged },
    )
  if (row.state === "waiting" || row.state === "cancelling") return yield* lose(notResumed)
  const pending = (yield* SessionPending.has(db, sessionID, "steer")) || (yield* SessionPending.has(db, sessionID, "queue"))
  if (row.state === "starting") {
    if (!pending) return yield* lose(notResumed)
    const started = yield* events.publishBatch(
      [{ definition: SessionEvent.Task.Updated, data: { sessionID, change: { type: "started" } } }],
      { when: unchanged },
    )
    if (started.length > 0) yield* input.execution.wake(sessionID)
    return
  }
  const interrupted = yield* interruptedByRestart(db, sessionID)
  if (!interrupted && !pending) return yield* lose(notResumed)
  const assistant = yield* SessionHistory.latest(db, sessionID, "assistant").pipe(Effect.orDie)
  const uncertain = interrupted && assistant ? yield* uncertainTools(db, sessionID, assistant) : []
  const incomplete = interrupted && assistant ? incompleteInputs(sessionID, assistant) : []
  if (assistant && uncertain.length > 0)
    return yield* ask({ db, events, sessionID, row, assistant, uncertain, incomplete, unchanged })
  if (yield* recoveredWithoutProgress(db, sessionID)) return yield* lose(notResumedAgain)
  if (interrupted && !pending && assistant && finalAnswer(assistant)) {
    yield* events.publishBatch(
      [
        {
          definition: SessionEvent.Task.Updated,
          data: { sessionID, change: { type: "completed", excerpt: truncateUtf8(assistantText(assistant), 16 * 1024) } },
        },
      ],
      { when: unchanged },
    )
    return
  }
  const resumed = yield* events.publishBatch(
    [
      ...incomplete,
      {
        definition: SessionEvent.Task.Updated,
        data: { sessionID, change: { type: "resumed" } },
        options: { id: EventRuntime.ID.make(`evt_task_restart_resumed_${row.session_id}_${row.revision + 1}`) },
      },
    ],
    { when: unchanged },
  )
  if (resumed.length === 0) return
  yield* input.execution.resume(sessionID).pipe(Effect.ignore, Effect.forkIn(input.lifetime, { startImmediately: true }))
})

const ask = Effect.fnUntraced(function* (input: {
  readonly db: Db
  readonly events: EventRuntime.Interface
  readonly sessionID: SessionSchema.ID
  readonly row: Row
  readonly assistant: Assistant
  readonly uncertain: ReadonlyArray<ToolPart>
  readonly incomplete: ReturnType<typeof incompleteInputs>
  readonly unchanged: Effect.Effect<boolean>
}) {
  const names = [...new Set(input.uncertain.map((part) => part.name))].join(", ")
  const question = Question.make({
    id: QuestionID.make(`qst_${Hash.sha256(`${input.row.session_id}\0${input.row.revision}\0restart`).slice(0, 24)}`),
    text: truncateUtf8(
      `The service restarted while these tool calls were running: ${names}. Their effects are unknown and they were not retried. The user must choose Continue or Stop.`,
      8 * 1024,
    ),
    time: yield* Clock.currentTimeMillis,
  })
  const rootID = (yield* SessionReviewFold.rootOf(input.db, input.sessionID)) ?? input.sessionID
  yield* SessionReviewFold.withFamilyLock(rootID)(input.events.publishBatch(
    [
      ...input.uncertain
        .filter((part) => part.state.status === "running")
        .map((part) => ({
          definition: SessionEvent.Tool.Failed,
          data: {
            sessionID: input.sessionID,
            assistantMessageID: input.assistant.id,
            callID: part.id,
            error: {
              type: "aborted",
              message: `The service restarted while ${part.name} was running; its effect is unknown and it was not retried.`,
            },
            executed: part.executed === true,
          },
        })),
      ...input.incomplete,
      { definition: SessionEvent.Task.Updated, data: { sessionID: input.sessionID, change: { type: "question_asked", question } } },
      {
        definition: SessionEvent.Review.Deferred,
        data: {
          sessionID: input.sessionID,
          itemID: SessionReview.ID.create(),
          kind: "recovery",
          reason: "restart",
          origin: { questionID: question.id },
          payload: {
            type: "recovery",
            tools: input.uncertain.map((part) => ({ messageID: input.assistant.id, callID: part.id, name: part.name })),
          },
        },
      },
    ],
    { when: input.unchanged },
  ))
})

const interruptedByRestart = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  const latest = yield* db
    .select({ type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), inArray(EventTable.type, lifecycle)))
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (latest?.type === versioned(SessionEvent.Execution.Failed))
    return Option.exists(
      Schema.decodeUnknownOption(SessionEvent.Execution.Failed.data)(latest.data),
      (data) => data.error.type === "interrupted",
    )
  if (latest?.type !== versioned(SessionEvent.Execution.Interrupted)) return false
  if (
    !Option.exists(
      Schema.decodeUnknownOption(SessionEvent.Execution.Interrupted.data)(latest.data),
      (data) => data.reason === "shutdown",
    )
  )
    return false
  const session = yield* db
    .select({ suspended: SessionTable.time_suspended })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return session?.suspended !== null && session?.suspended !== undefined
})

const uncertainTools = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID, assistant: Assistant) {
  const continued = new Set(
    (yield* SessionReviewFold.fold(db, [sessionID])).flatMap((item) =>
      item.payload.type === "recovery" && item.decision?.kind === "recovery" && "choice" in item.decision && item.decision.choice === "continue"
        ? item.payload.tools.map((tool) => `${tool.messageID}\0${tool.callID}`)
        : [],
    ),
  )
  return assistant.content.filter(
    (part): part is ToolPart =>
      part.type === "tool" &&
      part.time.ran !== undefined &&
      (part.state.status === "running" || (part.state.status === "error" && part.state.error.type === "aborted")) &&
      !continued.has(`${assistant.id}\0${part.id}`),
  )
})

function incompleteInputs(sessionID: SessionSchema.ID, assistant: Assistant) {
  return assistant.content
    .filter((part): part is ToolPart => part.type === "tool" && part.state.status === "streaming")
    .map((part) => ({
      definition: SessionEvent.Tool.Failed,
      data: {
        sessionID,
        assistantMessageID: assistant.id,
        callID: part.id,
        error: {
          type: "tool.input-json",
          message: "Tool call arguments were incomplete when the service restarted and were not executed. Retry the call if it is still needed.",
        },
        executed: false,
      },
    }))
}

const recoveredWithoutProgress = Effect.fnUntraced(function* (db: Db, sessionID: SessionSchema.ID) {
  const latest = Effect.fnUntraced(function* (condition: SQL | undefined) {
    const row = yield* db
      .select({ seq: sql<number | null>`max(${EventTable.seq})` })
      .from(EventTable)
      .where(and(eq(EventTable.aggregate_id, sessionID), condition))
      .get()
      .pipe(Effect.orDie)
    return row?.seq ?? null
  })
  const resumed = yield* latest(
    and(
      eq(EventTable.type, versioned(SessionEvent.Task.Updated)),
      sql`json_extract(${EventTable.data}, '$.change.type') = 'resumed'`,
    ),
  )
  if (resumed === null) return false
  const ended = yield* latest(eq(EventTable.type, versioned(SessionEvent.Step.Ended)))
  return ended === null || ended < resumed
})

function finalAnswer(assistant: Assistant) {
  return (
    assistant.time.completed !== undefined &&
    assistant.error === undefined &&
    assistantText(assistant).trim().length > 0 &&
    !assistant.content.some((part) => part.type === "tool" && part.executed !== true)
  )
}

function assistantText(assistant: Assistant) {
  return assistant.content
    .filter((part): part is Extract<Assistant["content"][number], { readonly type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
}
