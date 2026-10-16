export * as SessionInterruptedExecution from "./interrupted"

import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../../database/database"
import { EventRuntime } from "../../event"
import { EventSequenceTable, EventTable } from "../../event/sql"
import type { AppProcess } from "../../process"
import { ShellLedger } from "../../shell/ledger"
import { SessionEvent } from "../event"
import { SessionSchema } from "../schema"
import { SessionTaskTable } from "../sql"

const versioned = (definition: Extract<EventRuntime.Definition, { durability: "durable" }>) =>
  EventRuntime.versionedType(definition.type, definition.durable.version)

const error = { type: "interrupted", message: "The server stopped before this run finished" }

/**
 * Settles every Session whose latest execution lifecycle event is a start, except a managed child
 * task whose claiming process is alive or cannot be verified. It records the missing terminal events
 * and never resumes work.
 */
export const reconcile = Effect.fn("SessionInterruptedExecution.reconcile")(function* (
  db: Database.Interface["db"],
  events: EventRuntime.Interface,
  appProcess: AppProcess.Interface,
) {
  const latest = (type: string) =>
    sql`(select max(${EventTable.seq}) from ${EventTable}
      where ${EventTable.aggregate_id} = ${EventSequenceTable.aggregate_id}
        and ${EventTable.type} = ${type})`
  const rows = yield* db
    .select({ aggregateID: EventSequenceTable.aggregate_id })
    .from(EventSequenceTable)
    .where(sql`${latest(versioned(SessionEvent.Execution.Started))} > max(
      coalesce(${latest(versioned(SessionEvent.Execution.Succeeded))}, -1),
      coalesce(${latest(versioned(SessionEvent.Execution.Failed))}, -1),
      coalesce(${latest(versioned(SessionEvent.Execution.Interrupted))}, -1))`)
    .all()
    .pipe(Effect.orDie)
  const unterminated = rows.map((row) => SessionSchema.ID.make(row.aggregateID))
  if (unterminated.length === 0) return
  const claims = yield* db
    .select({
      sessionID: SessionTaskTable.session_id,
      ownerPid: SessionTaskTable.owner_pid,
      ownerStarted: SessionTaskTable.owner_started,
    })
    .from(SessionTaskTable)
    .where(
      and(
        inArray(SessionTaskTable.session_id, unterminated),
        isNotNull(SessionTaskTable.owner_pid),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const snapshot = claims.length === 0 ? Option.some([]) : yield* ShellLedger.processes(appProcess).pipe(Effect.option)
  if (Option.isNone(snapshot))
    yield* Effect.logWarning("could not list processes; executions of claimed child tasks were not reconciled")
  const owned = new Set(
    claims
      .filter(
        (claim) => Option.isNone(snapshot) || ShellLedger.alive(snapshot.value, claim.ownerPid, claim.ownerStarted),
      )
      .map((claim) => claim.sessionID),
  )
  yield* Effect.forEach(
    unterminated.filter((sessionID) => !owned.has(sessionID)),
    (sessionID) =>
      Effect.gen(function* () {
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
