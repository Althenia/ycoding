export * as SessionTask from "./task"

import { inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionTable, SessionTaskTable } from "./sql"

type DatabaseService = Database.Interface["db"]

const staleStates = ["starting", "running", "waiting", "cancelling"] as const

export const reconcileStaleTasks = (db: DatabaseService) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ parent_id: SessionTaskTable.parent_id })
      .from(SessionTaskTable)
      .where(inArray(SessionTaskTable.state, [...staleStates]))
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return
    const now = Date.now()
    yield* db
      .update(SessionTaskTable)
      .set({
        state: "failed",
        revision: sql`${SessionTaskTable.revision} + 1`,
        time_updated: now,
      })
      .where(inArray(SessionTaskTable.state, [...staleStates]))
      .run()
      .pipe(Effect.orDie)
    const parentIDs = [...new Set(rows.map((row) => row.parent_id))]
    if (parentIDs.length === 0) return
    yield* db
      .update(SessionTable)
      .set({
        orchestration_revision: sql`${SessionTable.orchestration_revision} + 1`,
        time_updated: sql`${SessionTable.time_updated}`,
      })
      .where(inArray(SessionTable.id, parentIDs))
      .run()
      .pipe(Effect.orDie)
  })
