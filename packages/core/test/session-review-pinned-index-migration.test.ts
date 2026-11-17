import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { desc, isNotNull, sql } from "drizzle-orm"
import { DatabaseMigration } from "@ycoding-ai/core/database/migration"
import { SessionTable } from "@ycoding-ai/core/session/sql"
import { migrations } from "../src/database/migration.gen"
import previousSchema from "./fixture/database-current-2026-07-25"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"

const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const added = (id: string) => id.endsWith("_review-pinned-indexes")
const indexes = ["event_review_type_aggregate_seq_idx", "session_pinned_time_updated_id_idx"]

test("adds the review-event and pinned-session partial indexes to an existing database without changing rows", async () => {
  await run(
    Effect.gen(function* () {
      expect(migrations.filter((item) => added(item.id))).toHaveLength(1)
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* previousSchema.up(tx)
          yield* tx.run(sql`CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`)
          yield* Effect.forEach(
            migrations.filter((item) => item.id <= "20260803011247_session-usage"),
            (item) => tx.run(sql`INSERT INTO migration VALUES (${item.id}, 1)`),
          )
          yield* tx.run(sql`CREATE TABLE database_format (id TEXT PRIMARY KEY, time_created INTEGER NOT NULL)`)
          yield* tx.run(sql`INSERT INTO database_format VALUES ('current-2026-07-25', 1)`)
        }),
      )
      yield* DatabaseMigration.applyOnly(db, migrations.slice(0, migrations.findIndex((item) => added(item.id))))
      expect(yield* db.all(sql`SELECT name FROM sqlite_master WHERE name IN ('event_review_type_aggregate_seq_idx', 'session_pinned_time_updated_id_idx')`)).toEqual([])
      yield* db.run(sql`PRAGMA foreign_keys = ON`)
      yield* db.run(sql`INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('global', '/project', 1, 1, '[]')`)
      yield* db.run(sql`
        INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_pinned)
        VALUES ('ses_pinned', 'global', '/project', 'Pinned', 1, 2, 5), ('ses_plain', 'global', '/project', 'Plain', 1, 3, NULL)
      `)
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('ses_pinned', 2)`)
      yield* db.run(sql`
        INSERT INTO event (id, aggregate_id, seq, created, type, data)
        VALUES ('evt_review', 'ses_pinned', 1, 1, 'session.review.deferred.1', '{"sessionID":"ses_pinned","itemID":"rvw_retained"}'),
               ('evt_created', 'ses_pinned', 2, 2, 'session.created.1', '{"sessionID":"ses_pinned"}')
      `)
      const sessions = yield* db.all(sql`SELECT * FROM session ORDER BY id`)
      const events = yield* db.all(sql`SELECT * FROM event ORDER BY id`)
      const completed = yield* db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`)
      yield* DatabaseMigration.apply(db)
      yield* DatabaseMigration.apply(db)
      expect((yield* db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('event_review_type_aggregate_seq_idx', 'session_pinned_time_updated_id_idx') ORDER BY name`)).map((row) => row.name)).toEqual(indexes)
      expect(yield* db.all(sql`SELECT * FROM session ORDER BY id`)).toEqual(sessions)
      expect(yield* db.all(sql`SELECT * FROM event ORDER BY id`)).toEqual(events)
      const migrated = yield* db.all<{ id: string }>(sql`SELECT id FROM migration ORDER BY id`)
      expect(migrated.filter((row) => !added(row.id))).toEqual(completed)
      expect(migrated.filter((row) => added(row.id))).toHaveLength(1)
      expect(yield* db.all(sql`PRAGMA foreign_key_check`)).toEqual([])
      const pinned = db.select({ id: SessionTable.id }).from(SessionTable).where(isNotNull(SessionTable.time_pinned))
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id)).limit(1).toSQL()
      const plan = yield* db.all<{ detail: string }>(sql.raw(`EXPLAIN QUERY PLAN ${pinned.sql.replace("?", "1")}`))
      expect(plan.map((row) => row.detail)).toContainEqual(expect.stringContaining("session_pinned_time_updated_id_idx"))
      expect(yield* db.all(sql`SELECT id FROM session WHERE time_pinned IS NOT NULL ORDER BY time_updated DESC, id DESC`)).toEqual([{ id: "ses_pinned" }])
    }),
  )
})
