import { afterAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Deferred, Effect, Layer } from "effect"
import { Agent } from "../src/agent"
import { Database } from "../src/database/database"
import { sqliteLayer } from "../src/database/sqlite.bun"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { LocationServiceMap } from "../src/location-service-map"
import { CatalogModel } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { Provider } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionSchema } from "../src/session/schema"
import { SessionProviderRequestTable, SessionTable } from "../src/session/sql"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"

const sessionID = SessionSchema.ID.make("ses_usage_concurrency")
const requests = 25_000
const directories: string[] = []

afterAll(() => Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }))))

const row = (index: number) => ({
  id: ProviderRequest.ID.make(`prq_concurrency_${index.toString().padStart(6, "0")}`),
  session_id: sessionID,
  source: "step" as const,
  agent: Agent.defaultID,
  model: CatalogModel.Ref.make({
    providerID: Provider.ID.make("openai"),
    id: CatalogModel.ID.make(`model_${index % 7}`),
  }),
  route_id: "test",
  prompt_cache_key: "key",
  system_digest: "system",
  tool_digest: "tools",
  request: index + 1,
  attempts: 1,
  invalidation: "first-request" as const,
  continuation: "full" as const,
  cost: 0.001,
  tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 1 } },
  timing: { firstOutputMs: index % 500, totalMs: 500 + (index % 900) },
  time_created: 1_800_000_000_000 + index * 60_000,
})

async function fileDatabase(gate: Effect.Effect<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-usage-concurrency-"))
  directories.push(directory)
  let armed = true
  return Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      const context = yield* Layer.build(
        sqliteLayer({
          filename: join(directory, "usage.db"),
          readonly: true,
          readwrite: false,
          create: false,
          disableWAL: true,
        }),
      )
      const reader: Database.Interface["db"] = yield* EffectDrizzleSqlite.make().pipe(
        Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
          logQuery: (query) =>
            Effect.gen(function* () {
              if (!armed || !query.includes("CREATE TEMP TABLE usage_partial")) return
              armed = false
              expect((yield* Effect.serviceOption(reader.$client.transactionService))._tag).toBe("Some")
              expect(
                (yield* reader.$client
                  .unsafe<{ count: number }>("SELECT count(*) AS count FROM session_provider_request")
                  .pipe(Effect.orDie))[0]?.count,
              ).toBe(requests)
              yield* gate
            }),
        }),
        Effect.provide(EffectDrizzleSqlite.DefaultServices),
        Effect.provide(context),
      )
      return { ...database, reader }
    }),
  ).pipe(Layer.provide(Database.layer({ path: join(directory, "usage.db") })))
}

function runtime(database: Layer.Layer<Database.Service>) {
  return AppNodeBuilder.build(LayerNode.group([Database.node, Session.node, LocationServiceMap.node]), [
    [Database.node, database],
    [SessionExecution.node, SessionExecution.noopLayer],
  ])
}

const seed = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/concurrency"), sandboxes: [] })
    .run()
  yield* database.db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, directory: "/concurrency", title: "Concurrency" })
    .run()
  for (let start = 0; start < requests; start += 500)
    yield* database.db
      .insert(SessionProviderRequestTable)
      .values(Array.from({ length: 500 }, (_, offset) => row(start + offset)))
      .run()
  return database
}).pipe(Effect.orDie)

test("a file database opens a read-only connection that sees committed writes and refuses its own", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-usage-production-reader-"))
  directories.push(directory)
  const layer = Database.layer({ path: join(directory, "usage.db") })
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      expect(database.reader).toBeDefined()
      yield* database.db.run(sql`CREATE TABLE reader_probe (value INTEGER)`)
      yield* database.db.run(sql`INSERT INTO reader_probe VALUES (7)`)
      expect((yield* database.reader!.get<{ value: number }>(sql`SELECT value FROM reader_probe`))?.value).toBe(7)
      expect((yield* database.reader!.run(sql`INSERT INTO reader_probe VALUES (8)`).pipe(Effect.exit))._tag).toBe(
        "Failure",
      )
      expect((yield* database.db.get<{ count: number }>(sql`SELECT count(*) AS count FROM reader_probe`))?.count).toBe(
        1,
      )
    }).pipe(Effect.provide(layer), Effect.scoped),
  )
})

test("an in-memory database has no second connection", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      expect((yield* Database.Service).reader).toBeUndefined()
    }).pipe(Effect.provide(Database.layer({ path: ":memory:" })), Effect.scoped),
  ))

test("a cheap query on the main connection finishes while a usage report is still reading", async () => {
  const snapshot = Deferred.makeUnsafe<void>()
  const proceed = Deferred.makeUnsafe<void>()
  const layer = await fileDatabase(Deferred.succeed(snapshot, undefined).pipe(Effect.andThen(Deferred.await(proceed))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* Session.Service
      const order: string[] = []
      const report = session
        .usageReportAll({ group: "day", timeZone: "Asia/Kolkata" })
        .pipe(Effect.tap(() => Effect.sync(() => order.push("report"))))
      const cheap = database.db.get<{ one: number }>(sql`SELECT 1 AS one`).pipe(
        Effect.tap(() => Effect.sync(() => order.push("cheap"))),
        Effect.andThen(Deferred.succeed(proceed, undefined)),
      )
      const [result] = yield* Effect.all([report, Deferred.await(snapshot).pipe(Effect.andThen(cheap))], {
        concurrency: "unbounded",
      })
      expect(order).toEqual(["cheap", "report"])
      expect(result.total.logical).toBe(requests)
    }).pipe(Effect.provide(runtime(Layer.effect(Database.Service, seed).pipe(Layer.provide(layer)))), Effect.scoped),
  )
}, 60_000)

test("a write committed while a usage report reads is excluded from that report and included in the next", async () => {
  const snapshot = Deferred.makeUnsafe<void>()
  const proceed = Deferred.makeUnsafe<void>()
  const layer = await fileDatabase(Deferred.succeed(snapshot, undefined).pipe(Effect.andThen(Deferred.await(proceed))))
  await Effect.runPromise(
    Effect.gen(function* () {
      const database = yield* Database.Service
      const session = yield* Session.Service
      const written: number[] = []
      const writer = database.db
        .insert(SessionProviderRequestTable)
        .values(row(requests))
        .run()
        .pipe(
          Effect.tap(() => Effect.sync(() => written.push(requests))),
          Effect.andThen(Deferred.succeed(proceed, undefined)),
        )
      const [during] = yield* Effect.all(
        [session.usageReportAll({ group: "model" }), Deferred.await(snapshot).pipe(Effect.andThen(writer))],
        { concurrency: "unbounded" },
      )
      expect(written).toEqual([requests])
      expect(during.total.logical).toBe(requests)
      expect((yield* session.usageReportAll({ group: "model" })).total.logical).toBe(requests + 1)
    }).pipe(Effect.provide(runtime(Layer.effect(Database.Service, seed).pipe(Layer.provide(layer)))), Effect.scoped),
  )
}, 60_000)
