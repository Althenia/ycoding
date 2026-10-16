export * as RetentionSettings from "./retention-settings"

import { Context, Effect, Layer, Scope } from "effect"
import { Config } from "./config"
import { Global } from "./global"
import { Location } from "./location"
import { AbsolutePath } from "./schema"
import { makeGlobalNode, Node } from "./effect/app-node"
import { LayerNode } from "./effect/layer-node"

export interface Interface {
  readonly read: () => Effect.Effect<{
    readonly recordsDays: number
    readonly usageDays: number
    readonly latencyDays: number
  }>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/RetentionSettings") {}

function graph(options: Config.Options | undefined, directory: AbsolutePath) {
  return LayerNode.hoist(Config.configured(options), Node.tags.values.global, [
    [Location.node, Location.boundNode(Location.Ref.make({ directory }))],
  ])
}

export function configured(options?: Config.Options) {
  return makeGlobalNode({
    service: Service,
    layer: Layer.effect(
      Service,
      Effect.gen(function* () {
        const global = yield* Global.Service
        const lifetime = yield* Scope.Scope
        const context = yield* Effect.context()
        const settings = yield* Effect.cached(
          Layer.buildWithScope(
            LayerNode.compile(graph(options, AbsolutePath.make(global.config)).node).pipe(
              Layer.provide(Layer.succeedContext(context)),
            ),
            lifetime,
          ).pipe(
            Effect.map((built) => Context.get(built, Config.Service)),
            Effect.orDie,
          ),
        )
        return Service.of({
          read: Effect.fn("RetentionSettings.read")(function* () {
            const config = yield* settings
            const entries = yield* config.entries()
            const documents = entries
              .filter((entry): entry is Config.Document => entry.type === "document")
              .map((entry) => entry.info)
            return {
              recordsDays:
                documents.findLast((info) => info.session_retention?.records_days !== undefined)?.session_retention
                  ?.records_days ?? 7,
              usageDays:
                documents.findLast((info) => info.analytics_retention?.usage_days !== undefined)?.analytics_retention
                  ?.usage_days ?? 30,
              latencyDays:
                documents.findLast((info) => info.analytics_retention?.latency_days !== undefined)?.analytics_retention
                  ?.latency_days ?? 30,
            }
          }),
        })
      }),
    ),
    deps: [Global.node, graph(options, AbsolutePath.make(Global.Path.config)).hoisted],
  })
}

export const node = configured()
