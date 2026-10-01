export * as SessionInterruptedExecution from "./interrupted"

import { and, eq, gt, inArray, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../../database/database"
import { EventV2 } from "../../event"
import { EventTable } from "../../event/sql"
import { SessionEvent } from "../event"
import { SessionSchema } from "../schema"

const versioned = (definition: Extract<EventV2.Definition, { durability: "durable" }>) =>
  EventV2.versionedType(definition.type, definition.durable.version)

const error = { type: "interrupted", message: "The server stopped before this run finished" }

/**
 * Settles every Session whose latest execution lifecycle event is a start. Only a process that died
 * mid-run leaves that state, so this records the missing terminal events and never resumes work.
 */
export const reconcile = Effect.fn("SessionInterruptedExecution.reconcile")(function* (
  db: Database.Interface["db"],
  events: EventV2.Interface,
) {
  const latest = db
    .select({ aggregateID: EventTable.aggregate_id, seq: sql<number>`max(${EventTable.seq})`.as("seq") })
    .from(EventTable)
    .where(
      inArray(
        EventTable.type,
        [
          SessionEvent.Execution.Started,
          SessionEvent.Execution.Succeeded,
          SessionEvent.Execution.Failed,
          SessionEvent.Execution.Interrupted,
        ].map(versioned),
      ),
    )
    .groupBy(EventTable.aggregate_id)
    .as("latest_execution_event")
  const unterminated = yield* db
    .select({ aggregateID: EventTable.aggregate_id })
    .from(EventTable)
    .innerJoin(latest, and(eq(EventTable.aggregate_id, latest.aggregateID), eq(EventTable.seq, latest.seq)))
    .where(eq(EventTable.type, versioned(SessionEvent.Execution.Started)))
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
