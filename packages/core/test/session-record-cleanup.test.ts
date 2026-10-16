import { expect } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { sql } from "drizzle-orm"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { Sqlite } from "../src/database/sqlite"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { RetentionSettings } from "../src/retention-settings"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionUsageCleanup } from "../src/session/usage-cleanup"
import { SessionFileChangeCleanup } from "../src/session/file-change-cleanup"
import { SessionContextExclusionCleanup } from "../src/session/context-exclusion-cleanup"
import { testEffect } from "./lib/effect"

const active = new Set<Session.ID>()
const populations = new Map<string, number[]>()
let protect: string | undefined
let refresh: string | undefined
const sessionID = Session.ID.make("ses_record_batches")
const database = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as import("bun:sqlite").Database
    const db = yield* EffectDrizzleSqlite.make().pipe(
      Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
        logQuery: (query) =>
          Effect.sync(() => {
            const table =
              /^\s*delete from ["`]?(session_provider_request|session_usage|session_file_change|session_context_exclusion)\b/i.exec(
                query,
              )?.[1]
            if (!table) return
            const remaining = native.query(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }
            populations.set(table, [...(populations.get(table) ?? []), remaining.count])
            if (protect === table) active.add(sessionID)
            if (refresh === table)
              native.query("UPDATE session SET time_updated = ? WHERE id = ?").run(3 * 86_400_000, sessionID)
          }),
      }),
      Effect.provide(EffectDrizzleSqlite.DefaultServices),
    )
    yield* DatabaseMigration.apply(db)
    return { db }
  }),
).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      SessionUsageCleanup.node,
      SessionFileChangeCleanup.node,
      SessionContextExclusionCleanup.node,
    ]),
    [
      [Database.node, database],
      [SessionExecution.node, Layer.mock(SessionExecution.Service, { active: Effect.sync(() => active) })],
      [
        RetentionSettings.node,
        Layer.succeed(RetentionSettings.Service, {
          read: () => Effect.succeed({ recordsDays: 1, usageDays: 30, latencyDays: 30, incidentDays: 30 }),
        }),
      ],
    ],
  ),
)

const seed = Effect.gen(function* () {
  yield* TestClock.adjust(0)
  active.clear()
  protect = undefined
  refresh = undefined
  populations.clear()
  const db = (yield* Database.Service).db
  yield* db.run(
    "INSERT INTO project (id,worktree,sandboxes,time_created,time_updated) VALUES ('global','/records','[]',0,0)",
  )
  yield* db.run(
    sql`INSERT INTO session (id,project_id,directory,title,time_created,time_updated) VALUES (${sessionID},'global','/records','Records',0,0)`,
  )
  yield* db.run(sql`INSERT INTO session_context_revision (session_id,revision,time_created) VALUES (${sessionID},0,0)`)
  yield* db.run(
    sql`INSERT INTO compaction_manifest_blob (digest,schema_version,content,input_tokens,retained_tokens,time_created) VALUES (${"a".repeat(64)},1,'{}',1,0,0)`,
  )
  return db
})

const fixtures = [
  {
    service: SessionUsageCleanup.Service,
    table: "session_provider_request",
    insert: `INSERT INTO session_provider_request (id,session_id,source,agent,model,route_id,prompt_cache_key,system_digest,tool_digest,request,attempts,invalidation,continuation,tokens,time_created)
    SELECT printf('prq_%05d',value),'ses_record_batches','step','build','{"providerID":"p","id":"m"}','route','cache','system','tools',value,1,'first-request','full','{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}',0 FROM n`,
  },
  {
    service: SessionUsageCleanup.Service,
    table: "session_usage",
    insert: `INSERT INTO session_usage (session_id,model_key,model,logical,physical,helpers,continued,fallback,cost,input,output,reasoning,cache_read,cache_write)
    SELECT 'ses_record_batches',CAST(value AS TEXT),'{"providerID":"p","id":"m"}',1,1,0,0,0,1,1,0,0,0,0 FROM n`,
  },
  {
    service: SessionFileChangeCleanup.Service,
    table: "session_file_change",
    insert: `INSERT INTO session_file_change (session_id,path,patch,additions,deletions,latest_seq) SELECT 'ses_record_batches',printf('file_%05d',value),'patch',1,0,0 FROM n`,
  },
  {
    service: SessionContextExclusionCleanup.Service,
    table: "session_context_exclusion",
    insert: `INSERT INTO session_context_exclusion (session_id,context_revision,target_key,target_kind,target_selector,reason,manifest_digest)
    SELECT 'ses_record_batches',0,printf('%064x',value),'message','{}','exact_duplicate','${"a".repeat(64)}' FROM n`,
  },
] as const

for (const fixture of fixtures) {
  it.effect(`${fixture.table} deletes at most 100 rows per transaction`, () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db.run(
        `WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value < 10005) ${fixture.insert}`,
      )
      const cleanup = yield* fixture.service
      yield* cleanup.cleanup(3 * 86_400_000)
      const remaining = (yield* db.get<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM ${fixture.table}`)))!
        .count
      expect(remaining).toBe(0)
      const counts = [...(populations.get(fixture.table) ?? []), remaining]
      expect(counts.length).toBeGreaterThan(101)
      expect(counts.slice(1).every((count, index) => counts[index]! - count <= 100)).toBe(true)
    }),
  )
  it.effect(`${fixture.table} preserves remaining rows when execution begins during the sweep`, () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db.run(
        `WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value < 205) ${fixture.insert}`,
      )
      protect = fixture.table
      const cleanup = yield* fixture.service
      yield* cleanup.cleanup(3 * 86_400_000)
      expect((yield* db.get<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM ${fixture.table}`)))!.count).toBe(
        105,
      )
      expect(populations.get(fixture.table)).toHaveLength(1)
    }),
  )
  it.effect(`${fixture.table} rechecks the idle cutoff when a selected Session becomes recent`, () =>
    Effect.gen(function* () {
      const db = yield* seed
      yield* db.run(
        `WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value < 205) ${fixture.insert}`,
      )
      refresh = fixture.table
      const cleanup = yield* fixture.service
      yield* cleanup.cleanup(3 * 86_400_000)
      expect((yield* db.get<{ count: number }>(sql.raw(`SELECT count(*) AS count FROM ${fixture.table}`)))!.count).toBe(
        205,
      )
      expect(populations.get(fixture.table)).toHaveLength(1)
    }),
  )
}
