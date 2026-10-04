export * as SdkPlugins from "./sdk"

import type { Plugin } from "@ycoding-ai/plugin/effect/plugin"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { EventRuntime } from "../event"
import type { PluginRegistry } from "../plugin"

export const Updated = EventRuntime.ephemeral({ type: "sdk.plugin.updated", schema: {} })

/**
 * Holds plugins contributed by an embedding host application,
 * so `PluginSupervisor` can add them on every Location boot through the ordinary
 * generation path that `PluginSupervisor` uses for plugins discovered from
 * config. Registration publishes an unlocated update so every booted Location
 * reloads its plugin generation from the shared store.
 *
 * Each host-global layer owns one private store. Location graphs reuse that
 * layer through Effect's memoization, so separate hosts remain isolated while
 * every Location in one host sees the same registrations.
 */
export interface Interface {
  readonly register: (plugin: Plugin) => Effect.Effect<void>
  readonly all: () => readonly PluginRegistry.Versioned[]
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/SdkPlugins") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventRuntime.Service
    const plugins = new Map<string, PluginRegistry.Versioned>()
    let revision = 0
    return Service.of({
      register: (plugin) =>
        Effect.sync(() => {
          plugins.set(plugin.id, { ...plugin, version: String(++revision) })
        }).pipe(Effect.andThen(events.publish(Updated, {})), Effect.asVoid),
      all: () => [...plugins.values()],
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [EventRuntime.node] })
