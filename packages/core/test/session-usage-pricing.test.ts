import { expect, test } from "bun:test"
import { Context, Effect, Layer, LayerMap } from "effect"
import { Agent } from "../src/agent"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import type { LocationServices } from "../src/location-services"
import { CatalogModel } from "../src/model"
import { Project } from "../src/project"
import { ProjectTable } from "../src/project/sql"
import { Provider } from "../src/provider"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionUsagePricing } from "../src/session/usage-pricing"
import { SessionSchema } from "../src/session/schema"
import { SessionProviderRequestTable, SessionTable } from "../src/session/sql"
import { UsageAnalytics } from "../src/usage-analytics"
import { Money } from "@ycoding-ai/schema/money"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"

const directories = ["/pricing-a", "/pricing-b", "/pricing-missing"]

function harness() {
  const prices = new Map<string, number>(directories.map((directory) => [directory, 2]))
  const acquired: string[] = []
  const lookups: string[] = []
  const unavailable = new Set(["/pricing-missing"])
  const released: string[] = []
  const catalog = (directory: string) =>
    Context.make(Catalog.Service, {
      model: {
        get: (provider: Provider.ID, id: CatalogModel.ID) =>
          Effect.sync(() => {
            lookups.push(`${directory}:${provider}`)
            return {
              ...CatalogModel.Info.empty(provider, id),
              cost:
                provider === Provider.ID.openrouter
                  ? []
                  : [
                      {
                        input: Money.USDPerMillionTokens.make(prices.get(directory)!),
                        output: Money.USDPerMillionTokens.make(0),
                        cache: { read: Money.USDPerMillionTokens.make(0), write: Money.USDPerMillionTokens.make(0) },
                      },
                    ],
            }
          }),
      },
    } as unknown as Catalog.Interface) as Context.Context<LocationServices>
  const locations = Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const map = yield* LayerMap.make(
        (ref: Location.Ref) =>
          Layer.effectContext(
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released.push(ref.directory)
                }),
              )
              return catalog(ref.directory)
            }),
          ),
        { idleTimeToLive: "60 minutes" },
      )
      return {
        ...map,
        contextEffect: (ref: Location.Ref) =>
          Effect.suspend(() => {
            acquired.push(ref.directory)
            return unavailable.has(ref.directory)
              ? Effect.die({ _tag: "PlatformError", reason: { _tag: "NotFound" } })
              : map.contextEffect(ref)
          }),
      }
    }),
  )
  const database = Layer.effect(
    Database.Service,
    Effect.gen(function* () {
      const database = yield* Database.Service
      yield* database.db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/pricing-a"), sandboxes: [] })
        .run()
      yield* database.db
        .insert(SessionTable)
        .values(
          directories.map((directory, index) => ({
            id: SessionSchema.ID.make(`ses_pricing_${index}`),
            project_id: Project.ID.global,
            directory,
            title: directory,
          })),
        )
        .run()
      yield* database.db
        .insert(SessionProviderRequestTable)
        .values(
          directories.map((directory, index) => ({
            id: ProviderRequest.ID.make(`prq_pricing_${index}`),
            session_id: SessionSchema.ID.make(`ses_pricing_${index}`),
            source: "step" as const,
            agent: Agent.defaultID,
            model: CatalogModel.Ref.make({
              providerID: Provider.ID.make("openai"),
              id: CatalogModel.ID.make("priced-later"),
            }),
            route_id: "test",
            prompt_cache_key: "key",
            system_digest: "system",
            tool_digest: "tools",
            request: 1,
            attempts: 1,
            invalidation: "first-request" as const,
            continuation: "full" as const,
            tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time_created: index,
          })),
        )
        .run()
      yield* database.db.transaction(() => UsageAnalytics.backfill(database.db))
      return database
    }),
  ).pipe(Layer.provide(Database.layer({ path: ":memory:" })))
  const runtime = AppNodeBuilder.build(
    LayerNode.group([Database.node, Session.node, LocationServiceMap.node, EventRuntime.node]),
    [
      [UsageAnalytics.node, Layer.mock(UsageAnalytics.Service, {})],
      [Database.node, database],
      [SessionExecution.node, SessionExecution.noopLayer],
      [LocationServiceMap.node, locations],
    ],
  )
  const evict = (directory: string) =>
    Effect.gen(function* () {
      const locations = yield* LocationServiceMap.Service
      yield* locations.invalidate(
        Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID: undefined }),
      )
    })
  return { prices, acquired, lookups, runtime, unavailable, evict, released }
}

const refresh = (directory: string) =>
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    yield* events.publish(
      Catalog.Event.Updated,
      {},
      { location: Location.Ref.make({ directory: AbsolutePath.make(directory), workspaceID: undefined }) },
    )
  })

test("pricing resolved for a Location is reused across usage reads", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      expect((yield* session.usageAll()).cost).toBeCloseTo(4, 9)
      const afterFirst = { acquired: fixture.acquired.length, lookups: fixture.lookups.length }
      expect(afterFirst.lookups).toBe(4)
      expect((yield* session.usageAll()).cost).toBeCloseTo(4, 9)
      yield* session.usageReportAll({ group: "model" })
      yield* session.usageReportAll({ group: "day", timeZone: "Asia/Kolkata" })
      expect(fixture.lookups.length).toBe(afterFirst.lookups)
      expect(fixture.acquired.filter((directory) => directory !== "/pricing-missing")).toHaveLength(8)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
})

test("a catalog update for a Location replaces only that Location's cached pricing", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      expect((yield* session.usageAll()).cost).toBeCloseTo(4, 9)
      fixture.prices.set("/pricing-a", 5)
      fixture.prices.set("/pricing-b", 7)
      yield* refresh("/pricing-a")
      const updated = yield* session.usageAll()
      expect(updated.cost).toBeCloseTo(7, 9)
      expect(fixture.lookups.filter((lookup) => lookup.startsWith("/pricing-b")).length).toBe(2)
      yield* refresh("/pricing-b")
      const final = yield* session.usageAll()
      expect(final.cost).toBeCloseTo(12, 9)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
})

test("a catalog update without a Location replaces every cached price", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* session.usageAll()
      fixture.prices.set("/pricing-a", 10)
      fixture.prices.set("/pricing-b", 20)
      const events = yield* EventRuntime.Service
      yield* events.publish(Catalog.Event.Updated, {})
      const updated = yield* session.usageAll()
      expect(updated.cost).toBeCloseTo(30, 9)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
})

test("a missing Location stays unpriced and is retried instead of cached", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* session.usageAll()
      const first = fixture.acquired.filter((directory) => directory === "/pricing-missing").length
      yield* session.usageAll()
      expect(fixture.acquired.filter((directory) => directory === "/pricing-missing").length).toBe(first + 1)
      expect((yield* session.usageAll()).cost).toBeCloseTo(4, 9)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
})

test("a previously valid Location that becomes unavailable is unpriced", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      expect((yield* session.usageAll()).cost).toBeCloseTo(4, 9)
      fixture.unavailable.add("/pricing-a")
      expect((yield* session.usageAll()).cost).toBeCloseTo(2, 9)
      expect((yield* session.usageReportAll({ group: "model" })).total.cost).toBeCloseTo(2, 9)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
})

test("configuration changed after Location service eviction uses the new catalog instance", () => {
  const fixture = harness()
  return Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.Service
      yield* session.usageAll()
      fixture.prices.set("/pricing-a", 13)
      yield* fixture.evict("/pricing-a")
      expect(fixture.released).toEqual(["/pricing-a"])
      expect((yield* session.usageAll()).cost).toBeCloseTo(15, 9)
    }).pipe(Effect.provide(fixture.runtime), Effect.scoped),
  )
})

test("pricing retention bounds Locations, entries, and invalidation tokens", () => {
  const cache = SessionUsagePricing.make()
  const catalog = {} as Catalog.Interface
  const entry = { provider: [], router: [] }
  const first = cache.location("first", catalog)
  for (let index = 0; index < 257; index++) first.store(String(index), entry)
  expect(first.get("0")).toBeUndefined()
  expect(first.get("1")).toBe(entry)
  for (let index = 0; index < 128; index++) cache.location(String(index), catalog)
  expect(cache.location("first", catalog).get("1")).toBeUndefined()
  first.store("stale", entry)
  expect(cache.location("first", catalog).get("stale")).toBeUndefined()
  const active = cache.location("active", catalog)
  active.store("price", entry)
  cache.invalidate("active")
  active.store("stale", entry)
  expect(cache.location("active", catalog).get("stale")).toBeUndefined()
  expect(cache.location("active", catalog).get("price")).toBeUndefined()
  const replaced = cache.location("active", catalog)
  replaced.store("price", entry)
  expect(cache.location("active", {} as Catalog.Interface).get("price")).toBeUndefined()
})
