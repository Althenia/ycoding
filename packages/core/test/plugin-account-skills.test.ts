import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import type { LayerNode } from "../src/effect/layer-node"
import { AccountConnectors } from "../src/account-connectors"
import { Agent } from "../src/agent"
import { AISDK } from "../src/aisdk"
import { Catalog } from "../src/catalog"
import { EventRuntime } from "../src/event"
import { Integration } from "../src/integration"
import { Job } from "../src/job"
import { Location } from "../src/location"
import { LocationServiceMap } from "../src/location-service-map"
import { PluginCatalogHost } from "../src/plugin/catalog-host"
import { PluginPromise } from "../src/plugin/promise"
import { PluginRuntime } from "../src/plugin/runtime"
import { Session } from "../src/session"
import { SessionOrchestration } from "../src/session/orchestration"
import { AbsolutePath } from "../src/schema"
import { Workspace } from "../src/workspace"
import { Plugin } from "@ycoding-ai/plugin"
import { location } from "./fixture/location"
import { host } from "./plugin/host"

const ref = Location.Ref.make({ directory: AbsolutePath.make("/synthetic/current") })
const other = Location.Ref.make({
  directory: AbsolutePath.make("/synthetic/other"),
  workspaceID: Workspace.ID.make("wrk_other"),
})
const sessionID = Session.ID.make("ses_skills_plugin")
const otherSessionID = Session.ID.make("ses_skills_plugin_other")
const agentID = Agent.ID.make("fixture-agent")
const input = { integrationID: Integration.ID.make("openai"), sessionID, profile: "fixture-profile" }
const proof = {
  status: 200,
  keys: ["hazelnuts"],
  count: 1,
  hasNext: false,
  paginationKeys: [],
  detail: { status: 200, keys: ["id"] },
}
const info = (target = ref, agent: Agent.ID | undefined = agentID) =>
  Schema.decodeUnknownSync(Session.Info)({
    id: target.directory === other.directory ? otherSessionID : sessionID,
    projectID: "global",
    agent,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    title: "Synthetic",
    time: { created: 0, updated: 0 },
    location: Schema.encodeSync(Location.Ref)(target),
  })

const unusedSession = {
  daybreak: { set: () => Effect.die("Unexpected daybreak update") },
  autonomy: {
    get: () => Effect.die("Unexpected autonomy read"),
    set: () => Effect.die("Unexpected autonomy update"),
    effective: () => Effect.die("Unexpected autonomy resolution"),
  },
  revert: {
    stage: () => Effect.die("Unexpected revert stage"),
    clear: () => Effect.die("Unexpected revert clear"),
    commit: () => Effect.die("Unexpected revert commit"),
  },
}

function harness(options: { session?: Session.Info; before?: Effect.Effect<void>; failure?: Error } = {}) {
  const refs: Location.Ref[] = []
  const requests: LocationServiceMap.Nodes[] = []
  const sessionReads: Session.ID[] = []
  const calls: Parameters<AccountConnectors.Interface["skillsRead"]>[0][] = []
  const canonical = new Map([
    [sessionID, options.session ?? info()],
    [otherSessionID, info(other)],
  ])
  const connectors = Layer.mock(AccountConnectors.Service, {
    skillsRead: (value) => {
      calls.push(value)
      return options.failure
        ? Effect.fail(options.failure)
        : Effect.succeed({
            list: () => (options.before ?? Effect.void).pipe(Effect.as({ ...proof, ids: ["skill-fixture"] })),
            detail: () => Effect.succeed(proof.detail),
          })
    },
  })
  const deps = Layer.mergeAll(
    Layer.mock(Session.Service, {
      ...unusedSession,
      get: (id) => {
        sessionReads.push(id)
        const metadata = canonical.get(id)
        return metadata ? Effect.succeed(metadata) : Effect.fail(new Session.NotFoundError({ sessionID: id }))
      },
    }),
    Layer.mock(Job.Service, {}),
    Layer.mock(SessionOrchestration.Service, {}),
    Layer.mock(LocationServiceMap.Service, {
      get: <const Items extends LocationServiceMap.Nodes>(target: Location.Ref, nodes: Items) => {
        refs.push(target)
        requests.push(nodes)
        const selected = Layer.mergeAll(
          nodes.includes(LocationServiceMap.full) ? Layer.succeed(Location.Service, location(target)) : Layer.empty,
          nodes.includes(AccountConnectors.node) ? connectors : Layer.empty,
        )
        return Layer.unwrap(
          Layer.build(selected).pipe(
            Effect.map((context) =>
              Layer.succeedContext(Context.makeUnsafe<LayerNode.Output<Items[number]>>(context.mapUnsafe)),
            ),
          ),
        )
      },
    }),
  )
  return {
    refs,
    requests,
    sessionReads,
    calls,
    provider: (cell: PluginRuntime.Cell) => PluginRuntime.providerLayerWithCell(cell).pipe(Layer.provide(deps)),
  }
}

test("account skills runtime refuses unbound and retired cells through the error channel", async () => {
  const cell = PluginRuntime.makeCell()
  const runtime = await Effect.runPromise(PluginRuntime.Service.pipe(Effect.provide(PluginRuntime.layerWithCell(cell))))
  expect(
    await Effect.runPromise(runtime.location.integration.accountSkills.read(ref, input).pipe(Effect.flip)),
  ).toEqual(new Error("Plugin runtime is unavailable"))
  const h = harness()
  await Effect.runPromise(Effect.scoped(Layer.build(h.provider(cell))))
  expect(
    await Effect.runPromise(runtime.location.integration.accountSkills.read(ref, input).pipe(Effect.flip)),
  ).toEqual(new Error("Plugin runtime is unavailable"))
  expect(h.refs).toEqual([])
})

test("account skills provider boots without full services and resolves canonical provenance on invocation", async () => {
  const cell = PluginRuntime.makeCell()
  const h = harness()
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* Layer.build(h.provider(cell))
      expect(h.refs).toEqual([])
      const runtime = yield* PluginRuntime.Service.pipe(Effect.provide(PluginRuntime.layerWithCell(cell)))
      for (const target of [ref, other]) {
        const result = yield* runtime.location.integration.accountSkills.read(target, {
          ...input,
          sessionID: target === other ? otherSessionID : sessionID,
        })
        expect(result).toEqual({ location: new Location.Info(location(target)), data: proof })
      }
      expect(h.refs).toEqual([ref, other])
      expect(h.requests).toEqual([
        [LocationServiceMap.full, AccountConnectors.node],
        [LocationServiceMap.full, AccountConnectors.node],
      ])
      expect(h.sessionReads).toEqual([sessionID, otherSessionID])
      expect(h.calls).toEqual([
        { profile: "fixture-profile", permission: { sessionID, agent: agentID } },
        { profile: "fixture-profile", permission: { sessionID: otherSessionID, agent: agentID } },
      ])
      expect(yield* runtime.location.integration.accountSkills.read(other, input).pipe(Effect.flip)).toMatchObject({
        kind: "cross_location_session",
      })
      expect(h.calls).toHaveLength(2)
    }).pipe(Effect.scoped),
  )
})

test("account skills runtime rejects stale settlement and preserves a replacement cell", async () => {
  const cell = PluginRuntime.makeCell()
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const h = harness({ before: Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(release))) })
      const oldScope = yield* Scope.make()
      yield* Layer.build(h.provider(cell)).pipe(Effect.provideService(Scope.Scope, oldScope))
      const runtime = yield* PluginRuntime.Service.pipe(Effect.provide(PluginRuntime.layerWithCell(cell)))
      const pending = yield* runtime.location.integration.accountSkills.read(ref, input).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* Layer.build(harness().provider(cell))
      const replacement = cell.runtime
      yield* Scope.close(oldScope, Exit.void)
      expect(cell.runtime).toBe(replacement)
      yield* Deferred.succeed(release, undefined)
      expect(yield* Fiber.join(pending).pipe(Effect.flip)).toEqual(new Error("Plugin runtime is unavailable"))
      expect((yield* runtime.location.integration.accountSkills.read(ref, input)).data).toEqual(proof)
    }).pipe(Effect.scoped),
  )
})

test("account skills runtime interruption cancels the owned read", async () => {
  const cell = PluginRuntime.makeCell()
  await Effect.runPromise(
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>()
      let cancelled = false
      yield* Layer.build(
        harness({
          before: Deferred.succeed(ready, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                cancelled = true
              }),
            ),
          ),
        }).provider(cell),
      )
      const runtime = yield* PluginRuntime.Service.pipe(Effect.provide(PluginRuntime.layerWithCell(cell)))
      const fiber = yield* runtime.location.integration.accountSkills.read(ref, input).pipe(Effect.forkChild)
      yield* Deferred.await(ready)
      yield* Fiber.interrupt(fiber)
      expect(cancelled).toBe(true)
    }).pipe(Effect.scoped),
  )
})

test("catalog and Promise account skills bridges preserve explicit location and typed errors", async () => {
  const cell = PluginRuntime.makeCell()
  const h = harness()
  const unexpected = () => Effect.die("Unexpected catalog fixture operation")
  const catalogDeps = Layer.mergeAll(
    Layer.mock(AISDK.Service, { hook: { sdk: unexpected, language: unexpected } }),
    Layer.mock(Catalog.Service, {
      provider: { get: unexpected, all: unexpected, available: unexpected },
      model: {
        get: unexpected,
        all: unexpected,
        available: unexpected,
        default: unexpected,
        defaultSelection: unexpected,
        forConnection: unexpected,
        small: unexpected,
      },
    }),
    Layer.mock(EventRuntime.Service, {}),
    Layer.mock(Integration.Service, {
      connection: {
        snapshot: unexpected,
        active: unexpected,
        resolve: unexpected,
        key: unexpected,
        update: unexpected,
        activate: unexpected,
        remove: unexpected,
        refresh: unexpected,
      },
      oauth: { connect: unexpected, status: unexpected, complete: unexpected, cancel: unexpected },
      command: { connect: unexpected, status: unexpected, cancel: unexpected },
    }),
    Layer.succeed(Location.Service, location(ref)),
    PluginRuntime.layerWithCell(cell),
  )
  await Effect.runPromise(
    Effect.gen(function* () {
      const catalogHost = yield* PluginCatalogHost.make().pipe(Effect.provide(catalogDeps))
      yield* Layer.build(h.provider(cell))
      expect((yield* catalogHost.integration.accountSkills.read(input)).data).toEqual(proof)
      const fullHost = host({ integration: catalogHost.integration })
      yield* PluginPromise.fromPromise(
        Plugin.define({
          id: "skills-forwarding",
          setup: async (context) => {
            expect(
              (
                await context.integration.accountSkills.read({
                  ...input,
                  sessionID: otherSessionID,
                  location: { directory: other.directory, workspace: other.workspaceID },
                })
              ).data,
            ).toEqual(proof)
          },
        }),
      ).effect(fullHost)
      expect(h.refs).toEqual([ref, other])
      const denied = new Error("Synthetic configuration refusal")
      yield* Layer.build(harness({ failure: denied }).provider(cell))
      const error = yield* catalogHost.integration.accountSkills.read(input).pipe(Effect.flip)
      expect(error).toMatchObject({ kind: "account_skills_configuration", message: denied.message })
    }).pipe(Effect.scoped),
  )
})
