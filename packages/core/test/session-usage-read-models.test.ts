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
import { Session } from "../src/session"
import { SessionSchema } from "../src/session/schema"
import { SessionProviderRequestTable, SessionTable } from "../src/session/sql"
import { SessionExecution } from "../src/session/execution"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Agent } from "../src/agent"
import { SessionUsageRead } from "../src/session/usage-read"
import { sql } from "drizzle-orm"

test("global usage pages high-cardinality Session groups in SQL with exact totals and bounded results", () => {
  const queries: { sql: string; params: unknown[] }[] = []
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
      const rootID = SessionSchema.ID.make("ses_usage_root")
      yield* db
        .insert(SessionTable)
        .values({
          id: rootID,
          project_id: Project.ID.global,
          directory: "/project",
          title: "Root",
          permission: [{ action: "read", effect: "allow", resource: "x".repeat(256_000) }],
        })
        .run()
      const sessions = Array.from({ length: 405 }, (_, index) => ({
        id: SessionSchema.ID.make(`ses_usage_${index.toString().padStart(3, "0")}`),
        project_id: Project.ID.global,
        directory: "/project",
        title: `Session ${index}`,
        parent_id: rootID,
        permission: [
          { action: "read", effect: "allow" as const, resource: index === 0 ? "x".repeat(256_000) : "file" },
        ],
      }))
      yield* db.insert(SessionTable).values(sessions).run()
      yield* db
        .insert(SessionProviderRequestTable)
        .values(
          sessions.map((session, index) => ({
            id: ProviderRequest.ID.make(`prq_usage_${index}`),
            session_id: session.id,
            source: "step" as const,
            agent: Agent.defaultID,
            model: CatalogModel.Ref.make({
              providerID: Provider.ID.make("openai"),
              id: CatalogModel.ID.make(`model_${index.toString().padStart(3, "0")}`),
            }),
            route_id: "test",
            prompt_cache_key: "key",
            system_digest: "system",
            tool_digest: "tools",
            request: 1,
            attempts: 1,
            invalidation: "first-request" as const,
            continuation: "full" as const,
            cost: 1,
            cache_read_reported: true,
            tokens: { input: 1, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            timing: {
              firstOutputMs: index,
              totalMs: index * 2,
              generatedTokens: 1,
              generationDurationNs: 1_000_000_000,
            },
            time_created: index,
          })),
        )
        .run()
      return { db }
    }),
  ).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const session = yield* Session.Service
      queries.length = 0
      const report = yield* session.usageReportAll({
        group: "session",
        sort: "steps",
        order: "desc",
        offset: 300,
        limit: 3,
      })
      expect(report).toMatchObject({
        rowCount: 405,
        nextOffset: 303,
        total: { logical: 405, physical: 405, cost: 405, tokens: { input: 405 }, cacheReadReported: true },
      })
      expect(report.rows.map((row) => row.key)).toEqual(["ses_usage_300", "ses_usage_301", "ses_usage_302"])
      expect(report.rows[0]?.speed).toEqual({
        samples: 1,
        firstOutputP50Ms: 300,
        firstOutputP95Ms: 300,
        totalP50Ms: 600,
        totalP95Ms: 600,
        outputTokensPerSecond: 1,
      })
      const reads = queries.filter(
        (query) => /^\s*select/i.test(query.sql) && /session_provider_request|\bfrom ["`]?session\b/i.test(query.sql),
      )
      expect(reads.length).toBeGreaterThan(0)
      for (const query of reads) {
        const rows = yield* db.$client.unsafe(query.sql, query.params)
        expect(rows.length).toBeLessThanOrEqual(200)
        expect(JSON.stringify(rows).length).toBeLessThan(32_768)
      }
      expect((yield* session.usageReportAll({ group: "session", offset: 999_999, limit: 3 })).rows).toEqual([])
      queries.length = 0
      const scoped = yield* session.usageReport({
        sessionID: SessionSchema.ID.make("ses_usage_root"),
        group: "session",
        offset: 300,
        limit: 3,
      })
      expect(scoped.total.logical).toBe(405)
      expect(scoped.rowCount).toBe(405)
      expect(scoped.rows.map((row) => row.key)).toEqual(["ses_usage_300", "ses_usage_301", "ses_usage_302"])
      const familyReads = queries.filter(
        (query) => /^\s*select/i.test(query.sql) && /\bfrom ["`]?session["`]?\s/i.test(query.sql),
      )
      for (const query of familyReads) {
        const rows = yield* db.$client.unsafe(query.sql, query.params)
        expect(rows.length).toBeLessThanOrEqual(200)
        expect(JSON.stringify(rows).length).toBeLessThan(32_768)
      }
      for (const group of ["session", "model"] as const) {
        queries.length = 0
        const wide = yield* session.usageReportAll({ group, offset: 100, limit: 100 })
        expect(wide.rows).toHaveLength(100)
        expect(wide.total.logical).toBe(405)
        const timingReads = queries.filter((query) => query.sql.includes("firstOutputMs"))
        expect(timingReads.length).toBeLessThanOrEqual(1)
        expect(timingReads.length).toBeGreaterThan(0)
        const plan = yield* db.$client.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${timingReads[0]!.sql}`,
          timingReads[0]!.params,
        )
        expect(plan.filter((row) => /\bSCAN r\b/.test(row.detail)).length).toBeLessThanOrEqual(
          group === "session" ? 0 : 1,
        )
        if (group === "session")
          expect(plan.some((row) => /SEARCH r USING INDEX session_provider_request_session_/.test(row.detail))).toBe(
            true,
          )
        expect(plan.some((row) => /encoded/.test(row.detail))).toBe(false)
      }
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Database.node, Session.node]), [
          [Database.node, database],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      ),
      Effect.scoped,
    ),
  )
})

test("SQL model grouping preserves encodeURIComponent keys and ordering", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      const sessionID = SessionSchema.ID.make("ses_encoded_usage")
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, project_id: Project.ID.global, directory: "/project", title: "Encoded keys" })
        .run()
      const models = ["space model", "quote'()!*", "unicode-ไทย-😀", "slash/model", "percent%model"].map((id, index) =>
        CatalogModel.Ref.make({
          providerID: Provider.ID.make("custom"),
          id: CatalogModel.ID.make(id),
          ...(index === 0 ? { variant: CatalogModel.VariantID.make("high") } : {}),
          ...(index === 1 ? { profile: "named profile" } : {}),
        }),
      )
      yield* db
        .insert(SessionProviderRequestTable)
        .values(
          models.map((model, index) => ({
            id: ProviderRequest.ID.make(`prq_encoded_${index}`),
            session_id: sessionID,
            source: "step" as const,
            agent: Agent.defaultID,
            model,
            route_id: "test",
            prompt_cache_key: "key",
            system_digest: "system",
            tool_digest: "tools",
            request: index + 1,
            attempts: 1,
            invalidation: "first-request" as const,
            continuation: "full" as const,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time_created: index === 0 ? -1 : index,
          })),
        )
        .run()
      const key = yield* SessionUsageRead.key(db, sql`1`, "model")
      const rows = yield* SessionUsageRead.page(db, sql`1`, key, sql`key ASC`, 0, 100, sql`NULL`)
      expect(rows.map((row) => row.key)).toEqual(
        models
          .map((model) =>
            [model.providerID, model.id, model.variant, model.profile]
              .flatMap((part) => (part === undefined ? [] : [encodeURIComponent(part)]))
              .join("/"),
          )
          .sort(),
      )
      const utc = yield* SessionUsageRead.key(db, sql`1`, "day")
      expect(
        (yield* SessionUsageRead.page(db, sql`1`, utc, sql`key ASC`, 0, 100, sql`NULL`)).map((row) => row.key),
      ).toEqual(["1969-12-31", "1970-01-01"])
      const local = yield* SessionUsageRead.key(db, sql`1`, "day", "Asia/Kolkata")
      expect(
        (yield* SessionUsageRead.page(db, sql`1`, local, sql`key ASC`, 0, 100, sql`NULL`)).map((row) => row.key),
      ).toEqual(["1970-01-01"])
    }).pipe(Effect.provide(Database.layer({ path: ":memory:" })), Effect.scoped),
  ))
