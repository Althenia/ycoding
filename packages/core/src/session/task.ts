export * as SessionTask from "./task"

import { and, asc, eq, exists, gt, inArray, isNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { AppProcess } from "../process"
import { ShellLedger } from "../shell/ledger"
import { SessionEvent } from "./event"
import { SessionTaskNotificationTable, SessionTaskTable } from "./sql"
import { SessionTable } from "./sql"
import { CoordinationMemberTable } from "../coordination/sql"
import type { SessionSchema } from "./schema"

type DatabaseService = Database.Interface["db"]

const staleStates = ["starting", "running", "waiting", "cancelling"] as const
const reconciled = new WeakSet<DatabaseService>()
const locks = KeyedMutex.makeUnsafe<DatabaseService>()

export const hasOwnedMembers = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  db.select({ id: CoordinationMemberTable.session_id }).from(CoordinationMemberTable)
    .innerJoin(SessionTable, eq(SessionTable.id, CoordinationMemberTable.session_id))
    .where(and(eq(CoordinationMemberTable.owner_session_id, sessionID), isNull(SessionTable.time_archived)))
    .limit(1).get().pipe(Effect.orDie, Effect.map(row => row !== undefined))

export const superviseAttached = Effect.fn("SessionTask.superviseAttached")(function* (db: DatabaseService, events: EventRuntime.Interface, sessionID: SessionSchema.ID) {
  yield* events.publishBatch([{ definition: SessionEvent.Task.Updated, data: { sessionID, change: { type: "supervising" } } }], {
    when: Effect.gen(function* () {
      const row = yield* db.select({ state: SessionTaskTable.state }).from(SessionTaskTable)
        .where(eq(SessionTaskTable.session_id, sessionID)).get().pipe(Effect.orDie)
      return row?.state === "completed" && (yield* hasOwnedMembers(db, sessionID))
    }),
  })
})

export const completeUnownedSupervisors = Effect.fn("SessionTask.completeUnownedSupervisors")(function* (db: DatabaseService, events: EventRuntime.Interface) {
  let after: SessionSchema.ID | undefined
  while (true) {
    const rows = yield* db.select().from(SessionTaskTable)
      .where(and(eq(SessionTaskTable.state, "supervising"), after === undefined ? undefined : gt(SessionTaskTable.session_id, after)))
      .orderBy(asc(SessionTaskTable.session_id)).limit(100).all().pipe(Effect.orDie)
    if (rows.length === 0) return
    for (const row of rows) {
      if (yield* hasOwnedMembers(db, row.session_id)) continue
      yield* events.publishBatch([{ definition: SessionEvent.Task.Updated, data: { sessionID: row.session_id, change: { type: "completed" } },
        options: { id: EventRuntime.ID.make(`evt_task_ownership_completed_${row.session_id}_${row.revision + 1}`) } }], {
        when: Effect.gen(function* () {
          const current = yield* db.select({ state: SessionTaskTable.state }).from(SessionTaskTable)
            .where(eq(SessionTaskTable.session_id, row.session_id)).get().pipe(Effect.orDie)
          return current?.state === "supervising" && !(yield* hasOwnedMembers(db, row.session_id))
        }),
      })
    }
    after = rows.at(-1)!.session_id
    yield* Effect.yieldNow
  }
})

export const reconcileStaleTasks = (db: DatabaseService, appProcess: AppProcess.Interface) =>
  locks.withLock(db)(
    Effect.gen(function* () {
      if (reconciled.has(db)) return
      const events = yield* EventRuntime.Service
      const rows = yield* db
        .select({
          sessionID: SessionTaskTable.session_id,
          revision: SessionTaskTable.revision,
          ownerPid: SessionTaskTable.owner_pid,
          ownerStarted: SessionTaskTable.owner_started,
          state: SessionTaskTable.state,
          questionID: SessionTaskTable.question_id,
          question: SessionTaskTable.question,
          questionTime: SessionTaskTable.question_time,
        })
        .from(SessionTaskTable)
        .where(inArray(SessionTaskTable.state, [...staleStates]))
        .orderBy(asc(SessionTaskTable.session_id))
        .all()
        .pipe(Effect.orDie)
      if (rows.length > 0) {
        const snapshot = yield* ShellLedger.processes(appProcess).pipe(Effect.option)
        if (snapshot._tag === "None") {
          yield* Effect.logWarning("could not list processes; active child tasks were not reconciled")
          return
        }
        for (const row of rows) {
          if (ShellLedger.alive(snapshot.value, row.ownerPid, row.ownerStarted)) continue
          if (row.state === "waiting" && row.questionID !== null && row.question !== null && row.questionTime !== null)
            continue
          yield* events.publish(
            SessionEvent.Task.Updated,
            {
              sessionID: row.sessionID,
              change: {
                type: "lost",
                excerpt: "The service restarted while the child task was active. Provider execution was not resumed.",
              },
            },
            { id: EventRuntime.ID.make(`evt_task_restart_lost_${row.sessionID}_${row.revision + 1}`) },
          )
        }
      }
      reconciled.add(db)
    }),
  )

export const restartLoss = (db: DatabaseService) =>
  exists(
    db
      .select({ id: EventTable.id })
      .from(EventTable)
      .where(
        eq(
          EventTable.id,
          sql`'evt_task_restart_lost_' || ${SessionTaskNotificationTable.task_session_id} || '_' || ${SessionTaskNotificationTable.revision}`,
        ),
      ),
  )

export const lostSessions = (db: DatabaseService) =>
  db
    .select({ sessionID: SessionTaskNotificationTable.parent_id })
    .from(SessionTaskNotificationTable)
    .where(and(eq(SessionTaskNotificationTable.delivered, false), restartLoss(db)))
    .all()
    .pipe(Effect.orDie, Effect.map((rows) => new Set(rows.map((row) => row.sessionID))))
