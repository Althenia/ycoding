export * as CoordinationSettings from "./coordination-settings"

import { Context, Effect, Layer, Scope } from "effect"
import { Config } from "./config"
import { ConfigCoordination } from "./config/coordination"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { makeGlobalNode, Node } from "./effect/app-node"
import { LayerNode } from "./effect/layer-node"

export interface Interface {
  readonly read: () => Effect.Effect<ConfigCoordination.Resolved>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/CoordinationSettings") {}

function graph(options: Config.Options | undefined, directory: AbsolutePath) {
  return LayerNode.hoist(Config.configured({ ...options, project: false }), Node.tags.values.global, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory }))],
  ])
}

export function configured(options?: Config.Options) {
  return makeGlobalNode({
    service: Service,
    layer: Layer.effect(Service, Effect.gen(function* () {
      const global = yield* Global.Service
      const scope = yield* Scope.Scope
      const context = yield* Effect.context()
      const settings = yield* Effect.cached(Layer.buildWithScope(
        LayerNode.compile(graph(options, AbsolutePath.make(global.config)).node).pipe(Layer.provide(Layer.succeedContext(context))), scope,
      ).pipe(Effect.map((built) => Context.get(built, Config.Service)), Effect.orDie))
      return Service.of({ read: Effect.fn("CoordinationSettings.read")(function* () {
        const config = yield* settings
        yield* config.reload({ notify: false })
        const diagnostics = yield* config.diagnostics()
        if (diagnostics.some((diagnostic) => diagnostic.reason === "invalid-json"))
          return ConfigCoordination.resolve({ delegated_decisions: { enabled: false } })
        const entries = yield* config.entries()
        const policy = entries.flatMap((entry) => entry.type === "document" && entry.info.coordination?.delegated_decisions
          ? [entry.info.coordination.delegated_decisions] : []).reduce((current, next) => ({ ...current, ...next }), {})
        return ConfigCoordination.resolve({ delegated_decisions: policy })
      }) })
    })),
    deps: [Global.node, graph(options, AbsolutePath.make(Global.Path.config)).hoisted],
  })
}

export const node = configured()
