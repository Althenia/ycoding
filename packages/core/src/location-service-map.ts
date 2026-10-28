import { Context, Effect, Layer, type Scope } from "effect"
import { LayerNode } from "./effect/layer-node"
import { Node } from "./effect/app-node"
import { Location } from "./location"
import type { LocationError, LocationServices } from "./location-services"

export type Nodes = readonly Node.LocationNode<unknown, unknown>[]

export interface Loaded {
  readonly ref: Location.Ref
  readonly built: readonly string[]
}

export interface Interface {
  readonly get: <const Items extends Nodes>(
    ref: Location.Ref,
    nodes: Items,
  ) => Layer.Layer<LayerNode.Output<Items[number]>, LayerNode.Error<Items[number]>>
  readonly contextEffect: <const Items extends Nodes>(
    ref: Location.Ref,
    nodes: Items,
  ) => Effect.Effect<Context.Context<LayerNode.Output<Items[number]>>, LayerNode.Error<Items[number]>, Scope.Scope>
  readonly invalidate: (ref: Location.Ref) => Effect.Effect<void>
  readonly loaded: () => Effect.Effect<readonly Loaded[]>
}

export class Service extends Context.Service<Service, Interface>()("@ycoding/example/LocationServiceMap") {
  static get<const Items extends Nodes>(ref: Location.Ref, nodes: Items) {
    return Layer.unwrap(Effect.map(Service, (locations) => locations.get(ref, nodes)))
  }
}

export const full: Node.LocationNode<LocationServices, LocationError> = {
  kind: "group",
  name: "@ycoding/LocationServiceMap/full",
  dependencies: [],
}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as LocationServiceMap from "./location-service-map"
