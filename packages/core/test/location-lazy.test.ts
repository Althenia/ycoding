import fs from "fs"
import os from "os"
import path from "path"
import { afterAll, describe, expect } from "bun:test"
import { Money } from "@ycoding-ai/schema/money"
import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "../src/agent"
import { Catalog } from "../src/catalog"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Node } from "../src/effect/app-node"
import { LayerNode } from "../src/effect/layer-node"
import { EventRuntime } from "../src/event"
import { LocationWatcher } from "../src/filesystem/location-watcher"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { MCP } from "../src/mcp"
import { CatalogModel } from "../src/model"
import { ModelsDev } from "../src/models-dev"
import { PluginRegistry } from "../src/plugin"
import { CatalogContributions } from "../src/plugin/catalog-contributions"
import { PluginSupervisor } from "../src/plugin/supervisor"
import { Project } from "../src/project"
import { ProjectCopy } from "../src/project/copy"
import { ProjectTable } from "../src/project/sql"
import { Provider } from "../src/provider"
import { Pty } from "../src/pty"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionSchema } from "../src/session/schema"
import { SessionProviderRequestTable, SessionTable } from "../src/session/sql"
import { Shell } from "../src/shell"
import { ToolRegistry } from "../src/tool/registry"
import { UsageAnalytics } from "../src/usage-analytics"
import { testEffect } from "./lib/effect"

const pricedModels = [
  ModelsDev.node,
  ModelsDev.configured({ file: path.join(import.meta.dir, "plugin/fixtures/models-dev-priced.json"), fetch: false }),
] as const
const acme = Provider.ID.make("acme")
const priced = CatalogModel.ID.make("priced")
const heavy = [
  MCP.node.name,
  LocationWatcher.node.name,
  ToolRegistry.node.name,
  Pty.node.name,
  Shell.node.name,
  ProjectCopy.refreshNode.name,
  PluginSupervisor.node.name,
  PluginRegistry.node.name,
]

const directories = Array.from({ length: 3 }, () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ycoding-lazy-"))))
fs.writeFileSync(
  path.join(directories[2]!, "ycoding.json"),
  JSON.stringify({
    providers: {
      acme: { models: { priced: { capabilities: { input: ["text", "image"] }, variants: [{ id: "custom", settings: { effort: "high" } }] } } },
    },
  }),
)
afterAll(() => directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })))
const refOf = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventRuntime.node, ModelsDev.node, LocationServiceMap.node]), [
    pricedModels,
  ]),
)

const seeded = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directories[0]!), sandboxes: [] })
      .run()
    yield* database.db
      .insert(SessionTable)
      .values(
        directories.slice(0, 2).map((directory, index) => ({
          id: SessionSchema.ID.make(`ses_lazy_${index}`),
          project_id: Project.ID.global,
          directory,
          title: directory,
        })),
      )
      .run()
    yield* database.db
      .insert(SessionProviderRequestTable)
      .values(
        directories.slice(0, 2).map((_, index) => ({
          id: ProviderRequest.ID.make(`prq_lazy_${index}`),
          session_id: SessionSchema.ID.make(`ses_lazy_${index}`),
          source: "step" as const,
          agent: Agent.defaultID,
          model: CatalogModel.Ref.make({ providerID: acme, id: priced }),
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

const usage = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Session.node, LocationServiceMap.node, EventRuntime.node]), [
    pricedModels,
    [UsageAnalytics.node, Layer.mock(UsageAnalytics.Service, {})],
    [Database.node, seeded],
    [SessionExecution.node, SessionExecution.noopLayer],
  ]),
)

type Boot = { readonly stages: Record<string, number> }
const captureBoots = () => {
  const boots: Boot[] = []
  const layer = Logger.layer(
    [
      Logger.make((options) => {
        const message = options.message
        if (Array.isArray(message) && message[0] === "location services booted") boots.push(message[1] as Boot)
      }),
    ],
    { mergeWithExisting: false },
  )
  return { boots, layer }
}

class Base extends Context.Service<Base, { readonly build: number }>()("test/lazy/Base") {}
class Left extends Context.Service<Left, { readonly base: number }>()("test/lazy/Left") {}
class Right extends Context.Service<Right, { readonly base: number }>()("test/lazy/Right") {}
class Flaky extends Context.Service<Flaky, { readonly attempt: number }>()("test/lazy/Flaky") {}
class FlakyError extends Schema.TaggedErrorClass<FlakyError>()("test/lazy/FlakyError", {}) {}

const probes = (options: { readonly gate?: Deferred.Deferred<void>; readonly started?: Deferred.Deferred<void> } = {}) => {
  const events: string[] = []
  let builds = 0
  let attempts = 0
  const base = Node.makeLocationNode({
    service: Base,
    layer: Layer.effect(
      Base,
      Effect.acquireRelease(
        Effect.gen(function* () {
          builds++
          events.push("build:base")
          if (options.started) yield* Deferred.succeed(options.started, undefined)
          if (options.gate) yield* Deferred.await(options.gate)
          return Base.of({ build: builds })
        }),
        () => Effect.sync(() => events.push("close:base")),
      ),
    ),
    deps: [],
  })
  const left = Node.makeLocationNode({
    service: Left,
    layer: Layer.effect(
      Left,
      Effect.acquireRelease(
        Effect.gen(function* () {
          const value = yield* Base
          events.push("build:left")
          return Left.of({ base: value.build })
        }),
        () => Effect.sync(() => events.push("close:left")),
      ),
    ),
    deps: [base],
  })
  const right = Node.makeLocationNode({
    service: Right,
    layer: Layer.effect(
      Right,
      Effect.acquireRelease(
        Effect.gen(function* () {
          const value = yield* Base
          events.push("build:right")
          return Right.of({ base: value.build })
        }),
        () => Effect.sync(() => events.push("close:right")),
      ),
    ),
    deps: [base],
  })
  const flaky = Node.makeLocationNode({
    service: Flaky,
    layer: Layer.effect(
      Flaky,
      Effect.suspend(() => (++attempts === 1 ? Effect.fail(new FlakyError()) : Effect.succeed(Flaky.of({ attempt: attempts })))),
    ),
    deps: [],
  })
  return { events, base, left, right, flaky, builds: () => builds, attempts: () => attempts }
}

const loadedFor = (ref: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return (yield* locations.loaded()).find((entry) => entry.ref.directory === ref.directory)
  })

describe("lazy Location services", () => {
  it.live("builds only the catalog closure for a pricing request", () =>
    Effect.gen(function* () {
      const capture = captureBoots()
      const ref = refOf(directories[0]!)
      yield* Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        const context = yield* locations.contextEffect(ref, CatalogContributions.nodes)
        const catalog = yield* Catalog.Service.pipe(Effect.provide(context))
        expect((yield* catalog.model.get(acme, priced))?.cost[0]?.input).toBe(Money.USDPerMillionTokens.make(2))
      }).pipe(Effect.scoped, Effect.provide(capture.layer))
      const built = (yield* loadedFor(ref))?.built ?? []
      expect(built).toEqual(expect.arrayContaining([Catalog.node.name, CatalogContributions.node.name]))
      heavy.forEach((name) => expect(built).not.toContain(name))
      expect(capture.boots).toHaveLength(1)
      heavy.forEach((name) => expect(Object.keys(capture.boots[0]!.stages)).not.toContain(name))
    }),
  )

  it.live("extends a Location to the full graph without constructing built services again", () =>
    Effect.gen(function* () {
      const capture = captureBoots()
      const ref = refOf(directories[1]!)
      yield* Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        yield* locations.contextEffect(ref, CatalogContributions.nodes)
        const context = yield* locations.contextEffect(ref, [LocationServiceMap.full])
        const supervisor = yield* PluginSupervisor.Service.pipe(Effect.provide(context))
        yield* supervisor.flush
      }).pipe(Effect.scoped, Effect.provide(capture.layer))
      expect(capture.boots).toHaveLength(2)
      const [slice, rest] = capture.boots.map((boot) => Object.keys(boot.stages))
      expect(slice).toContain(Catalog.node.name)
      expect(rest).toContain(MCP.node.name)
      expect(rest!.filter((name) => slice!.includes(name))).toEqual([])
      expect((yield* loadedFor(ref))?.built).toEqual(expect.arrayContaining(heavy))
    }),
  )

  it.live("reuses shared dependencies across extensions and finalizes in reverse construction order", () =>
    Effect.gen(function* () {
      const nodes = probes()
      const locations = yield* LocationServiceMap.Service
      const ref = refOf("/lazy/order")
      const first = yield* Effect.scoped(locations.contextEffect(ref, [nodes.left]))
      const second = yield* Effect.scoped(locations.contextEffect(ref, [nodes.right]))
      expect(Context.get(first, Left).base).toBe(1)
      expect(Context.get(second, Right).base).toBe(1)
      const both: unknown = yield* Effect.scoped(locations.contextEffect(ref, [nodes.left, nodes.right]))
      expect(both).toBe(second)
      expect(nodes.events).toEqual(["build:base", "build:left", "build:right"])
      yield* locations.invalidate(ref)
      expect(nodes.events.slice(3)).toEqual(["close:right", "close:left", "close:base"])
      expect(yield* loadedFor(ref)).toBeUndefined()
    }),
  )

  it.effect("releases an idle Location after the idle time and keeps a touched one", () =>
    Effect.gen(function* () {
      const nodes = probes()
      const locations = yield* LocationServiceMap.Service
      const ref = refOf("/lazy/idle")
      yield* Effect.scoped(locations.contextEffect(ref, [nodes.left]))
      yield* TestClock.adjust("59 minutes")
      yield* Effect.scoped(locations.contextEffect(ref, [nodes.left]))
      yield* TestClock.adjust("59 minutes")
      expect(nodes.events).not.toContain("close:base")
      expect(yield* loadedFor(ref)).toBeDefined()
      yield* TestClock.adjust("1 minute")
      yield* Effect.yieldNow
      expect(nodes.events).toEqual(["build:base", "build:left", "close:left", "close:base"])
      expect(yield* loadedFor(ref)).toBeUndefined()
    }),
  )

  it.live("constructs a shared dependency once for concurrent requests", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const nodes = probes({ gate, started })
      const locations = yield* LocationServiceMap.Service
      const ref = refOf("/lazy/concurrent")
      const left = yield* Effect.scoped(locations.contextEffect(ref, [nodes.left])).pipe(Effect.forkChild)
      const right = yield* Effect.scoped(locations.contextEffect(ref, [nodes.right])).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Deferred.succeed(gate, undefined)
      expect(Context.get(yield* Fiber.join(left), Left).base).toBe(1)
      expect(Context.get(yield* Fiber.join(right), Right).base).toBe(1)
      expect(nodes.builds()).toBe(1)
      yield* locations.invalidate(ref)
    }),
  )

  it.live("retires a Location whose build failed so the next request rebuilds it", () =>
    Effect.gen(function* () {
      const nodes = probes()
      const locations = yield* LocationServiceMap.Service
      const ref = refOf("/lazy/failure")
      const failed = yield* Effect.scoped(locations.contextEffect(ref, [nodes.flaky])).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* loadedFor(ref)).toBeUndefined()
      const context = yield* Effect.scoped(locations.contextEffect(ref, [nodes.flaky]))
      expect(Context.get(context, Flaky).attempt).toBe(2)
      yield* locations.invalidate(ref)
    }),
  )

  it.live("finishes a build whose caller was interrupted without constructing it again", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const nodes = probes({ gate, started })
      const locations = yield* LocationServiceMap.Service
      const ref = refOf("/lazy/interrupt")
      const caller = yield* Effect.scoped(locations.contextEffect(ref, [nodes.left])).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(caller)
      yield* Deferred.succeed(gate, undefined)
      const context = yield* Effect.scoped(locations.contextEffect(ref, [nodes.left]))
      expect(Context.get(context, Left).base).toBe(1)
      expect(nodes.builds()).toBe(1)
      yield* locations.invalidate(ref)
      expect(nodes.events.filter((event) => event === "close:base")).toHaveLength(1)
    }),
  )

  it.live("shares frozen models.dev data across Locations and copies it only where a Location changes it", () =>
    Effect.gen(function* () {
      const models = yield* ModelsDev.Service
      const snapshot = yield* models.get()
      const source = snapshot.find((provider) => provider.info.id === acme)!.models[0]!
      expect(Object.isFrozen(source)).toBe(true)
      expect(Object.isFrozen(source.cost[0])).toBe(true)
      expect(Object.isFrozen(source.capabilities.input)).toBe(true)
      const locations = yield* LocationServiceMap.Service
      const read = (directory: string) =>
        Effect.gen(function* () {
          const context = yield* locations.contextEffect(refOf(directory), CatalogContributions.nodes)
          const catalog = yield* Catalog.Service.pipe(Effect.provide(context))
          return (yield* catalog.model.get(acme, priced))!
        }).pipe(Effect.scoped)
      const first = yield* read(directories[0]!)
      const second = yield* read(directories[1]!)
      const configured = yield* read(directories[2]!)
      expect(first.cost).toBe(source.cost)
      expect(second.cost).toBe(first.cost)
      expect(configured.capabilities.input).toEqual(["text", "image"])
      expect(configured.variants?.map((variant) => variant.id)).toContain(CatalogModel.VariantID.make("custom"))
      expect(first.capabilities.input).toEqual(["text"])
      expect(source.capabilities.input).toEqual(["text"])
    }),
  )

  usage.live("prices usage from the catalog closure without constructing heavy Location services", () =>
    Effect.gen(function* () {
      const capture = captureBoots()
      const session = yield* Session.Service
      expect((yield* session.usageAll().pipe(Effect.provide(capture.layer))).cost).toBeCloseTo(4, 9)
      expect(capture.boots).toHaveLength(2)
      for (const boot of capture.boots) heavy.forEach((name) => expect(Object.keys(boot.stages)).not.toContain(name))
      for (const directory of directories.slice(0, 2)) {
        const built = (yield* loadedFor(refOf(directory)))?.built ?? []
        heavy.forEach((name) => expect(built).not.toContain(name))
      }
    }),
  )

  usage.live("does not acquire a Location again when its teardown publishes catalog updates", () =>
    Effect.gen(function* () {
      const capture = captureBoots()
      const session = yield* Session.Service
      const events = yield* EventRuntime.Service
      const locations = yield* LocationServiceMap.Service
      const ref = refOf(directories[0]!)
      yield* session.usageAll().pipe(Effect.provide(capture.layer))
      const teardown = yield* Deferred.make<void>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.suspend(() =>
          event.type === Catalog.Event.Updated.type && event.location?.directory === ref.directory
            ? Deferred.succeed(teardown, undefined)
            : Effect.void,
        ).pipe(Effect.asVoid),
      )
      yield* locations.invalidate(ref).pipe(Effect.provide(capture.layer))
      yield* Deferred.await(teardown)
      yield* Effect.sleep("200 millis")
      yield* unsubscribe
      expect(yield* loadedFor(ref)).toBeUndefined()
      expect(capture.boots).toHaveLength(2)
    }),
  )
})
