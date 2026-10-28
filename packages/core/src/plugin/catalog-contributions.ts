export * as CatalogContributions from "./catalog-contributions"

import { Event } from "@ycoding-ai/schema/config"
import { Plugin } from "@ycoding-ai/schema/plugin"
import { Context, Effect, Exit, Layer, Scope, Semaphore, Stream } from "effect"
import { AISDK } from "../aisdk"
import { Catalog } from "../catalog"
import { Config } from "../config"
import { ConfigPolicyPlugin } from "../config/plugin/policy"
import { ConfigProviderPlugin } from "../config/plugin/provider"
import { Credential } from "../credential"
import { makeLocationNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { EventRuntime } from "../event"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Integration } from "../integration"
import { Location } from "../location"
import { ModelsDev } from "../models-dev"
import { Npm } from "../npm"
import type { PluginRegistry } from "../plugin"
import { ProviderUsageRuntime } from "../provider-usage"
import { State } from "../state"
import { WellKnown } from "../wellknown"
import { WellKnownPlugin } from "../wellknown/plugin"
import { PluginCatalogHost } from "./catalog-host"
import { ModelsDevPlugin } from "./models-dev"
import { PluginOperations } from "./operations"
import { ProviderPlugins } from "./provider"
import { PluginRuntime } from "./runtime"
import { VariantPlugin } from "./variant"

const pre: readonly PluginCatalogHost.Contribution[] = [WellKnownPlugin.Plugin, ModelsDevPlugin, ...ProviderPlugins]
const post: readonly PluginCatalogHost.Contribution[] = [
  ConfigProviderPlugin.Plugin,
  VariantPlugin.Plugin,
  ConfigPolicyPlugin.Plugin,
]

export interface Interface {
  readonly list: Effect.Effect<PluginRegistry.Surrounding>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/CatalogContributions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const events = yield* EventRuntime.Service
    const host = yield* PluginCatalogHost.make()
    const root = yield* Scope.make()
    const lock = Semaphore.makeUnsafe(1)
    const preIDs = new Set(pre.map((plugin) => plugin.id))
    let active: { readonly id: Plugin.ID; readonly phase: number; readonly scope: Scope.Closeable }[] = []
    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        active = []
        yield* State.batch(Scope.close(root, exit))
      }),
    )

    const load = Effect.fnUntraced(function* (plugin: PluginCatalogHost.Contribution) {
      const phase = preIDs.has(plugin.id) ? State.phases.pre : State.phases.post
      const child = yield* Scope.fork(root)
      const exit = yield* plugin
        .effect(host)
        .pipe(
          Effect.provideService(State.Phase, phase),
          Effect.provideService(Scope.Scope, child),
          Effect.withSpan("CatalogContributions.load", { attributes: { "plugin.id": plugin.id } }),
          Effect.exit,
        )
      if (Exit.isFailure(exit)) {
        yield* Scope.close(child, exit)
        yield* Effect.logWarning("failed to load plugin", { "plugin.id": plugin.id, cause: exit.cause })
        return
      }
      const id = Plugin.ID.make(plugin.id)
      active.push({ id, phase, scope: child })
      yield* events.publish(Plugin.Event.Added, { id })
    })

    const activate = lock.withPermit(
      Effect.gen(function* () {
        const entries = yield* config.entries()
        const operations = yield* PluginOperations.scan(entries)
        const enabled = yield* PluginOperations.resolve(pre, post, operations, Config.capabilities(entries))
        if (enabled.length === active.length && enabled.every((plugin, index) => active[index]?.id === plugin.id))
          return
        yield* State.batch(
          Effect.gen(function* () {
            const previous = active.toReversed()
            active = []
            yield* Effect.forEach(previous, (entry) => Scope.close(entry.scope, Exit.void), { discard: true })
            yield* Effect.forEach(enabled, load, { discard: true })
          }),
        )
        yield* events.publish(Plugin.Event.Updated, {})
      }),
    )

    const updates = yield* events
      .subscribe([Event.Updated])
      .pipe(Stream.toQueue({ capacity: 1, strategy: "sliding" }))
    yield* activate
    yield* Stream.fromQueue(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() =>
        activate.pipe(Effect.catchCause((cause) => Effect.logError("failed to reload catalog plugins", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({
      list: Effect.sync(() => ({
        pre: active.filter((entry) => entry.phase === State.phases.pre).map((entry) => ({ id: entry.id })),
        post: active.filter((entry) => entry.phase === State.phases.post).map((entry) => ({ id: entry.id })),
      })),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    AISDK.node,
    Catalog.node,
    Config.node,
    Credential.node,
    EventRuntime.node,
    FSUtil.node,
    Global.node,
    httpClient,
    Integration.node,
    Location.node,
    ModelsDev.node,
    Npm.node,
    PluginRuntime.node,
    ProviderUsageRuntime.node,
    WellKnown.node,
  ],
})

export const nodes = [Catalog.node, node] as const
