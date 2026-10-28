import { expect, test } from "bun:test"
import { EffectDrizzleSqlite } from "@ycoding-ai/effect-drizzle-sqlite"
import { Deferred, Duration, Effect, Fiber, Layer } from "effect"
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
import { UsageAnalytics } from "../src/usage-analytics"
import { UsageStage } from "../src/usage-stage"
import { SessionExecution } from "../src/session/execution"
import { Catalog } from "../src/catalog"
import { CatalogModel } from "../src/model"
import { Provider } from "../src/provider"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Agent } from "../src/agent"
import { Money } from "@ycoding-ai/schema/money"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import type { LocationServices } from "../src/location-services"
import { fixedLocations } from "./fixture/location-map"

for (const mode of ["summary", "report", "shared", "cancel"] as const)
  test(
    `usage ${mode} holds a coherent read snapshot while pricing cold Locations outside the transaction`,
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const start = yield* Deferred.make<void>()
          const writerStarted = yield* Deferred.make<void>()
          const writerDone = yield* Deferred.make<void>()
          const coldStarted = yield* Deferred.make<void>()
          const coldGate = yield* Deferred.make<void>()
          const readerJoined = yield* Deferred.make<void>()
          const outsideHeld = yield* Deferred.make<void>()
          const sessionID = SessionSchema.ID.make("ses_usage_snapshot")
          const location = Location.Ref.make({ directory: AbsolutePath.make("/cold-pricing"), workspaceID: undefined })
          let db: Database.Interface["db"] | undefined
          let armed = false
          let acquisitions = 0
          let closed = 0
          const database = Layer.effect(
            Database.Service,
            Effect.gen(function* () {
              const database = yield* EffectDrizzleSqlite.make().pipe(
                Effect.provideService(EffectDrizzleSqlite.EffectLogger, {
                  logQuery: (query) =>
                    Effect.gen(function* () {
                      const selected =
                        mode === "summary"
                          ? /\bunpriced\s*>\s*0/i.test(query)
                          : mode === "report" && query.includes("sum(r.first_output)")
                      if (!armed || !selected || !db) return
                      armed = false
                      yield* Deferred.succeed(start, undefined)
                      const transaction = yield* Effect.serviceOption(db.$client.transactionService)
                      yield* transaction._tag === "None" ? Deferred.await(writerDone) : Deferred.await(writerStarted)
                    }),
                }),
                Effect.provide(EffectDrizzleSqlite.DefaultServices),
              )
              db = database
              yield* DatabaseMigration.apply(database)
              yield* database
                .insert(ProjectTable)
                .values({ id: Project.ID.global, worktree: AbsolutePath.make("/cold-pricing"), sandboxes: [] })
                .run()
              yield* database
                .insert(SessionTable)
                .values({ id: sessionID, project_id: Project.ID.global, directory: "/cold-pricing", title: "Snapshot" })
                .run()
              return { db: database }
            }),
          ).pipe(Layer.provide(sqliteLayer({ filename: ":memory:" })))
          const catalog = Layer.mock(Catalog.Service, {
            provider: {
              get: () => Effect.succeed(undefined),
              all: () => Effect.succeed([]),
              available: () => Effect.succeed([]),
            },
            model: {
              get: (provider, id) =>
                Effect.succeed({
                  ...CatalogModel.Info.empty(provider, id),
                  cost: [
                    {
                      input: Money.USDPerMillionTokens.make(2),
                      output: Money.USDPerMillionTokens.make(0),
                      cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
                    },
                  ],
                }),
              all: () => Effect.succeed([]),
              available: () => Effect.succeed([]),
              default: () => Effect.succeed(undefined),
              defaultSelection: () => Effect.succeed(undefined),
              forConnection: (model) => Effect.succeed(model),
              small: () => Effect.succeed(undefined),
            },
          })
          const cold = Layer.unwrap(
            Effect.gen(function* () {
              const database = yield* Database.Service
              expect((yield* Effect.serviceOption(database.db.$client.transactionService))._tag).toBe("None")
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closed += 1
                }),
              )
              yield* Deferred.succeed(coldStarted, undefined)
              if (mode === "shared" || mode === "cancel") yield* Deferred.await(coldGate)
              if (mode === "summary") yield* Deferred.await(writerDone)
              expect(
                (yield* database.db.get<{ count: number }>("SELECT count(*) AS count FROM credential"))?.count,
              ).toBe(0)
              return catalog
            }),
          )
          const locations = Layer.effect(
            LocationServiceMap.Service,
            Effect.gen(function* () {
              const map = yield* fixedLocations(
                (_ref: Location.Ref) => cold as unknown as Layer.Layer<LocationServices>,
                { idleTimeToLive: Duration.zero },
              )
              return {
                ...map,
                contextEffect: (ref, nodes) =>
                  Effect.gen(function* () {
                    acquisitions += 1
                    if (acquisitions === 2) yield* Deferred.succeed(readerJoined, undefined)
                    expect(ref.directory).toBe(location.directory)
                    expect(ref.workspaceID).toBe(location.workspaceID)
                    return yield* map.contextEffect(location, nodes)
                  }),
              }
            }),
          ).pipe(Layer.provide(database))
          const insert = (db: Database.Interface["db"], id: string) =>
            db
              .insert(SessionProviderRequestTable)
              .values({
                id: ProviderRequest.ID.make(`prq_${id}`),
                session_id: sessionID,
                source: "step",
                agent: Agent.defaultID,
                model: CatalogModel.Ref.make({ providerID: Provider.ID.make("openai"), id: CatalogModel.ID.make(id) }),
                route_id: "test",
                prompt_cache_key: id,
                system_digest: "system",
                tool_digest: "tools",
                request: id === "old" ? 1 : 2,
                attempts: 1,
                invalidation: "first-request",
                continuation: "full",
                tokens: { input: 1_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                time_created: id === "old" ? 0 : 1,
              })
              .run()
              .pipe(Effect.andThen(db.transaction(() => UsageAnalytics.backfill(db).pipe(Effect.andThen(UsageStage.backfill(db))))), Effect.orDie)
          yield* Effect.gen(function* () {
            const database = yield* Database.Service
            const session = yield* Session.Service
            yield* insert(database.db, "old")
            if (mode === "shared" || mode === "cancel") {
              const locations = yield* LocationServiceMap.Service
              const outside = yield* locations
                .contextEffect(
                  Location.Ref.make({ directory: AbsolutePath.make("/cold-pricing"), workspaceID: undefined }),
                  [LocationServiceMap.full],
                )
                .pipe(Effect.andThen(Deferred.await(outsideHeld)), Effect.scoped, Effect.forkScoped)
              yield* Deferred.await(coldStarted)
              const reader = yield* session.usageAll().pipe(Effect.forkScoped)
              yield* Deferred.await(readerJoined)
              expect((yield* database.db.get<{ value: number }>("SELECT 1 AS value"))?.value).toBe(1)
              if (mode === "cancel") {
                yield* Fiber.interrupt(reader)
                yield* Fiber.interrupt(outside)
                expect((yield* database.db.get<{ value: number }>("SELECT 1 AS value"))?.value).toBe(1)
                expect(closed).toBe(1)
                return
              }
              yield* Deferred.succeed(coldGate, undefined)
              const summary = yield* Fiber.join(reader)
              expect(summary.logical).toBe(1)
              expect(summary.cost).toBeCloseTo(0.002, 12)
              expect(closed).toBe(0)
              yield* Deferred.succeed(outsideHeld, undefined)
              yield* Fiber.join(outside)
              expect(closed).toBe(1)
              return
            }
            const writer = yield* Effect.gen(function* () {
              yield* Deferred.await(start)
              yield* Deferred.succeed(writerStarted, undefined)
              yield* insert(database.db, "new")
              yield* Deferred.succeed(writerDone, undefined)
            }).pipe(Effect.forkScoped)
            armed = true
            if (mode === "summary") {
              const summary = yield* session.usageAll()
              expect(summary.logical).toBe(2)
              expect(summary.models).toHaveLength(2)
              expect(summary.cost).toBeCloseTo(0.004, 12)
            }
            if (mode === "report") {
              const report = yield* session.usageReportAll({ group: "model" })
              expect(report.total.logical).toBe(1)
              expect(report.rowCount).toBe(1)
              expect(report.rows).toHaveLength(1)
              expect(report.total.cost).toBeCloseTo(0.002, 12)
            }
            yield* Fiber.join(writer)
            expect(
              (yield* database.db.get<{ count: number }>("SELECT count(*) AS count FROM session_provider_request"))
                ?.count,
            ).toBe(2)
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([Database.node, Session.node, LocationServiceMap.node]), [
                [UsageAnalytics.node, Layer.mock(UsageAnalytics.Service, {})],
                [Database.node, database],
                [SessionExecution.node, SessionExecution.noopLayer],
                [LocationServiceMap.node, locations],
              ]),
            ),
          )
        }).pipe(Effect.scoped),
      ),
    10_000,
  )
