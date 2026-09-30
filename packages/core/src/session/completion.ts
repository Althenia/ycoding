export * as SessionCompletion from "./completion"

import { and, asc, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import type { Job } from "../job"
import { Hash } from "../util/hash"
import { SessionEvent } from "./event"
import { SessionSchema } from "./schema"
import { SessionPendingTable, SessionTable, SessionTaskNotificationTable, SessionTaskTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const historyDefinitions = [
  SessionEvent.Execution.Succeeded,
  SessionEvent.Execution.Failed,
  SessionEvent.Execution.Interrupted,
  SessionEvent.Step.Started,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
  SessionEvent.Text.Ended,
  SessionEvent.Tool.Input.Started,
  SessionEvent.Tool.Called,
  SessionEvent.Tool.Success,
  SessionEvent.Tool.Failed,
] as const
const decodeHistory = Schema.decodeUnknownSync(Schema.Union(historyDefinitions, { mode: "oneOf" }))
const versioned = (definition: Extract<EventV2.Definition, { durability: "durable" }>) =>
  EventV2.versionedType(definition.type, definition.durable.version)

class StaleCompletion extends Error {}

export const make = (options: {
  readonly db: DatabaseService
  readonly events: EventV2.Interface
  readonly jobs: Pick<Job.Interface, "list" | "outstandingSessions">
}) => {
  const gate = KeyedMutex.makeUnsafe<SessionSchema.ID>()
  return {
    complete: (sessionID: SessionSchema.ID, active: Effect.Effect<ReadonlySet<SessionSchema.ID>>) =>
      gate.withLock(sessionID)(
        Effect.gen(function* () {
          const candidate = yield* completionCandidate(options.db, sessionID)
          if (!candidate) return
          const existing = yield* options.db
            .select({ id: EventTable.id })
            .from(EventTable)
            .where(eq(EventTable.id, candidate.id))
            .get()
            .pipe(Effect.orDie)
          if (existing || (yield* unfinished(options.db, options.jobs, sessionID, active))) return
          yield* options.events
            .publish(SessionEvent.Work.Completed, candidate.data, {
              id: candidate.id,
              commit: () =>
                Effect.gen(function* () {
                  const current = yield* completionCandidate(options.db, sessionID)
                  if (
                    !current ||
                    current.id !== candidate.id ||
                    current.data.assistantMessageID !== candidate.data.assistantMessageID ||
                    (yield* unfinished(options.db, options.jobs, sessionID, active))
                  )
                    yield* Effect.die(new StaleCompletion())
                }),
            })
            .pipe(Effect.catchDefect((error) => (error instanceof StaleCompletion ? Effect.void : Effect.die(error))))
        }),
      ),
  }
}

export const latest = Effect.fn("SessionCompletion.latest")(function* (
  db: DatabaseService,
  input: { readonly after?: SessionSchema.ID; readonly limit: number },
) {
  if (
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 200 ||
    (input.after !== undefined && !Schema.is(SessionSchema.ID)(input.after))
  )
    return yield* Effect.die(new RangeError("Invalid completion page"))
  const latest = db
    .select({ aggregateID: EventTable.aggregate_id, seq: sql<number>`max(${EventTable.seq})`.as("seq") })
    .from(EventTable)
    .where(eq(EventTable.type, versioned(SessionEvent.Work.Completed)))
    .groupBy(EventTable.aggregate_id)
    .as("latest_completion")
  const rows = yield* db
    .select({ id: EventTable.id, seq: EventTable.seq, created: EventTable.created, data: EventTable.data })
    .from(EventTable)
    .innerJoin(latest, and(eq(EventTable.aggregate_id, latest.aggregateID), eq(EventTable.seq, latest.seq)))
    .innerJoin(SessionTable, eq(SessionTable.id, EventTable.aggregate_id))
    .where(
      and(isNull(SessionTable.parent_id), input.after === undefined ? undefined : gt(SessionTable.id, input.after)),
    )
    .orderBy(asc(SessionTable.id))
    .limit(input.limit + 1)
    .all()
    .pipe(Effect.orDie)
  const data = rows.slice(0, input.limit).map((row) => ({
    id: row.id,
    seq: EventV2.Seq.make(row.seq),
    created: row.created,
    ...Schema.decodeUnknownSync(SessionEvent.Work.Completed.data)(row.data),
  }))
  return { data, ...(rows.length > input.limit ? { next: data.at(-1)!.sessionID } : {}) }
})

const completionCandidate = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const execution = yield* db
    .select({ seq: EventTable.seq })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, versioned(SessionEvent.Execution.Started))))
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!execution) return undefined
  const rows = yield* db
    .select()
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        gt(EventTable.seq, execution.seq),
        inArray(EventTable.type, historyDefinitions.map(versioned)),
      ),
    )
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie)
  const history = rows.map((row) =>
    decodeHistory({
      id: row.id,
      type: row.type.slice(0, row.type.lastIndexOf(".")),
      created: row.created,
      durable: { aggregateID: sessionID, seq: row.seq, version: 1 },
      data: row.data,
    }),
  )
  const terminal = history.findLast((event) => event.type.startsWith("session.execution."))
  if (terminal?.type !== SessionEvent.Execution.Succeeded.type) return undefined
  const step = history.findLast((event) => event.type === SessionEvent.Step.Started.type)
  const ended = history.findLast((event) => event.type === SessionEvent.Step.Ended.type)
  if (!step || !ended || step.data.assistantMessageID !== ended.data.assistantMessageID || ended.data.finish !== "stop")
    return undefined
  if (
    !history.some(
      (event) =>
        event.type === SessionEvent.Text.Ended.type &&
        event.data.assistantMessageID === ended.data.assistantMessageID &&
        event.data.phase !== "commentary" &&
        event.data.text.trim(),
    )
  )
    return undefined
  const declaration = history
    .filter((event) => event.type === SessionEvent.Tool.Success.type)
    .findLast(
      (event) =>
        !event.data.executed &&
        event.data.structured.recorded === true &&
        history.some(
          (input) =>
            input.type === SessionEvent.Tool.Input.Started.type &&
            input.data.name === "task_complete" &&
            input.data.assistantMessageID === event.data.assistantMessageID &&
            input.data.callID === event.data.callID,
        ),
    )
  if (
    !declaration ||
    declaration.data.assistantMessageID === ended.data.assistantMessageID ||
    declaration.durable.seq >= step.durable.seq
  )
    return undefined
  const invokingStep = history.find(
    (event) =>
      event.type === SessionEvent.Step.Started.type &&
      event.data.assistantMessageID === declaration.data.assistantMessageID,
  )
  if (
    !invokingStep ||
    !history.some(
      (event) =>
        event.type === SessionEvent.Tool.Called.type &&
        event.data.assistantMessageID === declaration.data.assistantMessageID &&
        event.data.callID === declaration.data.callID &&
        !event.data.executed,
    )
  )
    return undefined
  if (
    history.some(
      (event) =>
        event.durable.seq > declaration.durable.seq &&
        (event.type === SessionEvent.Step.Failed.type ||
          event.type === SessionEvent.Tool.Failed.type ||
          (event.type === SessionEvent.Tool.Called.type &&
            event.data.assistantMessageID === ended.data.assistantMessageID)),
    )
  )
    return undefined
  const promoted = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, sessionID),
        eq(EventTable.type, versioned(SessionEvent.InputPromoted)),
        lt(EventTable.seq, invokingStep.durable.seq),
      ),
    )
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!promoted) return undefined
  const input = Schema.decodeUnknownSync(SessionEvent.InputPromoted.data)(promoted.data)
  const admitted = yield* db
    .select({ data: EventTable.data, seq: EventTable.seq })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, versioned(SessionEvent.InputAdmitted))))
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!admitted || Schema.decodeUnknownSync(SessionEvent.InputAdmitted.data)(admitted.data).inputID !== input.inputID)
    return undefined
  const revert = yield* db
    .select({ seq: EventTable.seq })
    .from(EventTable)
    .where(
      and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, versioned(SessionEvent.RevertEvent.Committed))),
    )
    .orderBy(desc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (revert && revert.seq > invokingStep.durable.seq) return undefined
  return {
    id: EventV2.ID.make(`evt_work_${Hash.sha256(`${sessionID}\0${admitted.seq}\0${revert?.seq ?? -1}`).slice(0, 24)}`),
    data: { sessionID, inputID: input.inputID, assistantMessageID: ended.data.assistantMessageID },
  }
})

const unfinished = Effect.fnUntraced(function* (
  db: DatabaseService,
  jobs: Pick<Job.Interface, "list" | "outstandingSessions">,
  sessionID: SessionSchema.ID,
  active: Effect.Effect<ReadonlySet<SessionSchema.ID>>,
) {
  const family = yield* db
    .all<{ id: SessionSchema.ID }>(
      sql`WITH RECURSIVE family(id) AS (
    SELECT ${SessionTable.id} FROM ${SessionTable} WHERE ${SessionTable.id} = ${sessionID}
    UNION SELECT child.id FROM session child JOIN family ON child.parent_id = family.id
  ) SELECT id FROM family`,
    )
    .pipe(Effect.orDie)
  const ids = family.map((row) => row.id)
  const running = yield* active
  if (
    ids.length === 0 ||
    !running.has(sessionID) ||
    Array.from(running).some((id) => id !== sessionID && ids.includes(id))
  )
    return true
  const pending = yield* db
    .select({ id: SessionPendingTable.id })
    .from(SessionPendingTable)
    .where(inArray(SessionPendingTable.session_id, ids))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (pending) return true
  const state = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(
      and(
        inArray(SessionTable.id, ids),
        sql`(${SessionTable.revert} IS NOT NULL OR json_extract(${SessionTable.autonomy}, '$.goal.status') = 'active')`,
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (state) return true
  const task = yield* db
    .select({ id: SessionTaskTable.session_id })
    .from(SessionTaskTable)
    .where(
      and(
        inArray(SessionTaskTable.parent_id, ids),
        inArray(SessionTaskTable.state, ["starting", "running", "waiting", "cancelling"]),
      ),
    )
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (task) return true
  const notice = yield* db
    .select({ id: SessionTaskNotificationTable.id })
    .from(SessionTaskNotificationTable)
    .where(and(inArray(SessionTaskNotificationTable.parent_id, ids), eq(SessionTaskNotificationTable.delivered, false)))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (notice) return true
  if (Array.from(yield* jobs.outstandingSessions()).some((id) => ids.includes(id))) return true
  return (yield* jobs.list()).some(
    (job) => job.status === "running" && ids.some((id) => id === job.metadata?.sessionID),
  )
})
