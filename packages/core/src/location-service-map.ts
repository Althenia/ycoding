import { Context, Effect, Layer, type Scope } from "effect"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { Location } from "./location"
import type { LocationError, LocationServices } from "./location-services"
import type { SessionScope } from "@ycoding-ai/schema/session-scope"
import type { ScopeUnavailableError } from "./session/error"
import type { StandaloneConfig } from "./config/standalone"
import path from "node:path"
import type { AbsolutePath } from "./schema"

export type Nodes = readonly Node.LocationNode<unknown, unknown>[]

export interface Loaded {
  readonly ref: Location.Ref
  readonly scope?: SessionScope
  readonly built: readonly string[]
}

export interface Interface {
  readonly get: <const Items extends Nodes, S extends SessionScope = "bound">(
    ref: Location.Ref,
    nodes: Items,
    scope?: S,
  ) => Layer.Layer<LayerNode.Output<Items[number]>, LayerNode.Error<Items[number]> | (S extends "standalone" ? ScopeUnavailableError | StandaloneConfig.InvalidError : never)>
  readonly contextEffect: <const Items extends Nodes, S extends SessionScope = "bound">(
    ref: Location.Ref,
    nodes: Items,
    scope?: S,
  ) => Effect.Effect<Context.Context<LayerNode.Output<Items[number]>>, LayerNode.Error<Items[number]> | (S extends "standalone" ? ScopeUnavailableError | StandaloneConfig.InvalidError : never), Scope.Scope>
  readonly invalidate: (ref: Location.Ref, scope?: SessionScope) => Effect.Effect<void>
  readonly loaded: () => Effect.Effect<readonly Loaded[]>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/example/LocationServiceMap") {
  static get<const Items extends Nodes, S extends SessionScope = "bound">(ref: Location.Ref, nodes: Items, scope?: S) {
    return Layer.unwrap(Effect.map(Service, (locations) => locations.get(ref, nodes, scope)))
  }
}

export const full: Node.LocationNode<LocationServices, LocationError> = {
  kind: "group",
  name: "@ycoding/LocationServiceMap/full",
  dependencies: [],
}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

export const invalidateDirectory = Effect.fn("LocationServiceMap.invalidateDirectory")(function* (locations: Interface, directory: AbsolutePath) {
  const target = path.resolve(directory)
  const loaded = yield* locations.loaded()
  yield* Effect.forEach(
    loaded.filter((entry) => entry.ref.directory === target),
    (entry) => locations.invalidate(entry.ref, entry.scope),
    { discard: true },
  )
})

export * as LocationServiceMap from "./location-service-map"
