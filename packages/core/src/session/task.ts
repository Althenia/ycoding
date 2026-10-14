export * as SessionTask from "./task"

import { and, asc, eq, exists, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { KeyedMutex } from "../effect/keyed-mutex"
import { EventRuntime } from "../event"
import { EventTable } from "../event/sql"
import { AppProcess } from "../process"
import { ShellLedger } from "../shell/ledger"
import { SessionEvent } from "./event"
import { SessionTaskNotificationTable, SessionTaskTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const staleStates = ["starting", "running", "waiting", "cancelling"] as const
const reconciled = new WeakSet<DatabaseService>()
const locks = KeyedMutex.makeUnsafe<DatabaseService>()

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
