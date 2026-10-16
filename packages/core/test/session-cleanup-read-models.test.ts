import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Effect, Layer } from "effect"
import { Database } from "../src/database/database"
import { DatabaseMigration } from "../src/database/migration"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionSchema } from "../src/session/schema"
import { SessionExecution } from "../src/session/execution"
import { RetentionSettings } from "../src/retention-settings"
import { SessionUsageCleanup } from "../src/session/usage-cleanup"
import { SessionFileChangeCleanup } from "../src/session/file-change-cleanup"

for (const kind of ["usage", "files"] as const)
  test(`${kind} housekeeping returns exact counts with bounded Session reads and no deleted-row materialization`, () => {
    const queries: { sql: string; params: unknown[] }[] = []
    const activeID = SessionSchema.ID.make("ses_active_cleanup")
    const database = Layer.effect(
      Database.Service,
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.make().pipe(
          Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
            logQuery: (sql, params) =>
              Effect.sync(() => {
                queries.push({ sql, params })
              }),
          }),
          Effect.provide(EffectDrizzleSqlite.DefaultServices),
        )
        yield* DatabaseMigration.apply(db)
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
        return { db }
      }),
    ).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))
    const execution = Layer.mock(SessionExecution.Service, { active: Effect.succeed(new Set([activeID])) })
    return Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* Effect.yieldNow
        for (const id of [
          activeID,
          ...Array.from({ length: 205 }, (_, index) =>
            SessionSchema.ID.make(`ses_cleanup_${index.toString().padStart(3, "0")}`),
          ),
        ]) {
          yield* db.run(
            `INSERT INTO session(id,project_id,directory,title,time_created,time_updated) VALUES ('${id}','global','/project','cleanup',0,0)`,
          )
          if (kind === "files")
            yield* db.run(
              `INSERT INTO session_file_change(session_id,path,patch,additions,deletions,latest_seq) VALUES ('${id}','file','@@',1,0,0)`,
            )
          if (kind === "usage")
            yield* db.run(
              `INSERT INTO session_provider_request(id,session_id,source,agent,model,route_id,prompt_cache_key,system_digest,tool_digest,request,attempts,invalidation,continuation,tokens,time_created) VALUES ('prq_${id}','${id}','step','build','{"providerID":"openai","id":"model"}','test','key','system','tools',1,1,'first-request','full','{"input":1,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}',0)`,
            )
        }
        queries.length = 0
        const cleanup = kind === "usage" ? yield* SessionUsageCleanup.Service : yield* SessionFileChangeCleanup.Service
        expect(yield* cleanup.cleanup(31 * 24 * 60 * 60 * 1_000)).toBe(205)
        const reads = queries.filter(
          (query) => /^select/i.test(query.sql) && /from ["`]?session["`]?\b/i.test(query.sql),
        )
        expect(reads.length).toBeGreaterThan(0)
        for (const query of reads)
          expect((yield* db.$client.unsafe(query.sql, query.params)).length).toBeLessThanOrEqual(200)
        expect(queries.some((query) => /\breturning\b/i.test(query.sql))).toBe(false)
        const retained = yield* db.get<{ count: number }>(
          `SELECT count(*) AS count FROM ${kind === "usage" ? "session_provider_request" : "session_file_change"}`,
        )
        expect(retained?.count).toBe(1)
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([Database.node, SessionUsageCleanup.node, SessionFileChangeCleanup.node]),
            [
              [Database.node, database],
              [SessionExecution.node, execution],
              [
                RetentionSettings.node,
                Layer.succeed(RetentionSettings.Service, {
                  read: () => Effect.succeed({ recordsDays: 7, usageDays: 30, latencyDays: 30, incidentDays: 30 }),
                }),
              ],
            ],
          ),
        ),
        Effect.scoped,
      ),
    )
  })
