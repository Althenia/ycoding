export * as PluginRegistry from "./plugin"

import type { Plugin } from "@ycoding-ai/plugin/effect/plugin"
import { Event, ID, type Info } from "@ycoding-ai/schema/plugin"
import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Exit, Layer, Scope, Semaphore } from "effect"
import { Agent } from "./agent"
import { AISDK } from "./aisdk"
import { Catalog } from "./catalog"
import { Command } from "./command"
import { EventRuntime } from "./event"
import { LocationAnnouncements } from "./location-announcements"
import { Integration } from "./integration"
import { Location } from "./location"
import { MCP } from "./mcp"
import { PluginHost } from "./plugin/host"
import { PluginRuntime } from "./plugin/runtime"
import { Reference } from "./reference"
import { Skill } from "./skill"
import { State } from "./state"
import { ToolRegistry } from "./tool/registry"
import { ToolHooks } from "./tool/hooks"
import { PluginHooks } from "./plugin/hooks"

export interface Surrounding {
  readonly pre: readonly Info[]
  readonly post: readonly Info[]
}

export interface Interface {
  readonly activate: (plugins: readonly Versioned[]) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Info[]>
  readonly surround: (plugins: Effect.Effect<Surrounding>) => Effect.Effect<void, never, Scope.Scope>
}

export interface Versioned extends Plugin {
  readonly version: string
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/Plugin") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const announcements = yield* LocationAnnouncements.Current
    const scope = yield* Scope.make()
    const active = new Map<typeof ID.Type, { readonly plugin: Versioned; readonly scope: Scope.Closeable }>()
    const lock = Semaphore.makeUnsafe(1)
    let host: Parameters<Plugin["effect"]>[0]

    const load = Effect.fnUntraced(function* (plugin: Versioned) {
      const child = yield* Scope.fork(scope)
      const inherit = yield* State.inherit()
      const loaded = yield* Effect.suspend(() => plugin.effect(host)).pipe(
        inherit,
        Effect.updateContext((_context: Context.Context<never>) =>
          Context.make(Scope.Scope, child).pipe(Context.add(State.Phase, State.phases.plugin)),
        ),
        Effect.withSpan("Plugin.load", { attributes: { "plugin.id": plugin.id } }),
        Effect.andThen(announcements.when(events.publish(Event.Added, { id: ID.make(plugin.id) }))),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void)),
        Effect.exit,
      )
      if (Exit.isSuccess(loaded)) return child
      yield* Effect.logWarning("failed to load plugin", {
        "plugin.id": plugin.id,
        cause: loaded.cause,
      })
      return undefined
    })

    const activate = Effect.fn("Plugin.activate")(function* (plugins: readonly Versioned[]) {
      const definitions = plugins.map((plugin) => ({ ...plugin, id: ID.make(plugin.id) }))
      const ids = new Set<typeof ID.Type>()
      for (const definition of definitions) {
        if (ids.has(definition.id)) yield* Effect.die(new Error(`Duplicate plugin ID: ${definition.id}`))
        ids.add(definition.id)
      }

      yield* lock.withPermit(
        Effect.gen(function* () {
          const next = definitions.map((definition) => ({ id: definition.id, version: definition.version }))
          const current = Array.from(active.values(), (entry) => ({
            id: entry.plugin.id,
            version: entry.plugin.version,
          }))
          if (
            current.length === next.length &&
            current.every((definition, index) => {
              const candidate = next[index]
              return definition.id === candidate?.id && definition.version === candidate.version
            })
          )
            return

          yield* State.batch(
            Effect.gen(function* () {
              for (const definition of definitions) {
                const previous = active.get(definition.id)
                active.delete(definition.id)
                if (previous) yield* Scope.close(previous.scope, Exit.void).pipe(Effect.ignore)

                const loaded = yield* load(definition)
                if (loaded) {
                  active.set(definition.id, { plugin: definition, scope: loaded })
                  continue
                }

                if (!previous) continue
                const restored = yield* load(previous.plugin)
                if (restored) {
                  active.set(definition.id, { plugin: previous.plugin, scope: restored })
                  continue
                }
                yield* Effect.logError("failed to restore plugin; deactivating", {
                  "plugin.id": definition.id,
                })
              }

              const removed = Array.from(active.entries())
                .filter(([id]) => !ids.has(id))
                .toReversed()
              removed.forEach(([id]) => active.delete(id))
              yield* Effect.forEach(removed, ([, entry]) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore), {
                discard: true,
              })
            }),
          )
          yield* announcements.when(events.publish(Event.Updated, {}))
        }),
      )
    })

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        active.clear()
        yield* State.batch(Scope.close(scope, exit))
      }),
    )

    let surrounding: Effect.Effect<Surrounding> = Effect.succeed({ pre: [], post: [] })
    const service = Service.of({
      activate,
      list: Effect.fn("Plugin.list")(function* () {
        const outer = yield* surrounding
        return [...outer.pre, ...Array.from(active.keys(), (id) => ({ id })), ...outer.post]
      }),
      surround: (plugins) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            surrounding = plugins
          }),
          () =>
            Effect.sync(() => {
              if (surrounding === plugins) surrounding = Effect.succeed({ pre: [], post: [] })
            }),
        ).pipe(Effect.asVoid),
    })
    host = yield* PluginHost.make(service)
    return service
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    EventRuntime.node,
    Agent.node,
    AISDK.node,
    Catalog.node,
    Command.node,
    Integration.node,
    MCP.node,
    Location.node,
    Reference.node,
    Skill.node,
    ToolRegistry.toolsNode,
    ToolHooks.node,
    PluginHooks.node,
    PluginRuntime.node,
  ],
})
