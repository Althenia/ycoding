export * as SessionInterruptedExecution from "./interrupted"

import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../../database/database"
import { EventRuntime } from "../../event"
import { EventSequenceTable, EventTable } from "../../event/sql"
import { SessionEvent } from "../event"
import { SessionSchema } from "../schema"

const versioned = (definition: Extract<EventRuntime.Definition, { durability: "durable" }>) =>
  EventRuntime.versionedType(definition.type, definition.durable.version)

const error = { type: "interrupted", message: "The server stopped before this run finished" }

/**
 * Settles every Session whose latest execution lifecycle event is a start. Only a process that died
 * mid-run leaves that state, so this records the missing terminal events and never resumes work.
 */
export const reconcile = Effect.fn("SessionInterruptedExecution.reconcile")(function* (
  db: Database.Interface["db"],
  events: EventRuntime.Interface,
) {
  const latest = (type: string) =>
    sql`(select max(${EventTable.seq}) from ${EventTable}
      where ${EventTable.aggregate_id} = ${EventSequenceTable.aggregate_id}
        and ${EventTable.type} = ${type})`
  const unterminated = yield* db
    .select({ aggregateID: EventSequenceTable.aggregate_id })
    .from(EventSequenceTable)
    .where(sql`${latest(versioned(SessionEvent.Execution.Started))} > max(
      coalesce(${latest(versioned(SessionEvent.Execution.Succeeded))}, -1),
      coalesce(${latest(versioned(SessionEvent.Execution.Failed))}, -1),
      coalesce(${latest(versioned(SessionEvent.Execution.Interrupted))}, -1))`)
    .all()
    .pipe(Effect.orDie)
  yield* Effect.forEach(
    unterminated,
    (row) =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(row.aggregateID)
        const step = yield* db
          .select({ seq: EventTable.seq, data: EventTable.data })
          .from(EventTable)
          .where(and(eq(EventTable.aggregate_id, sessionID), eq(EventTable.type, versioned(SessionEvent.Step.Started))))
          .orderBy(sql`${EventTable.seq} desc`)
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const closed =
          step === undefined ||
          (yield* db
            .select({ seq: EventTable.seq })
            .from(EventTable)
            .where(
              and(
                eq(EventTable.aggregate_id, sessionID),
                gt(EventTable.seq, step.seq),
                inArray(EventTable.type, [SessionEvent.Step.Ended, SessionEvent.Step.Failed].map(versioned)),
              ),
            )
            .limit(1)
            .get()
            .pipe(Effect.orDie)) !== undefined
        if (step && !closed)
          yield* events.publish(SessionEvent.Step.Failed, {
            sessionID,
            assistantMessageID: Schema.decodeUnknownSync(SessionEvent.Step.Started.data)(step.data).assistantMessageID,
            error,
          })
        yield* events.publish(SessionEvent.Execution.Failed, { sessionID, error })
      }),
    { discard: true },
  )
})
