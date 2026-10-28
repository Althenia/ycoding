import { type Duration, Effect, type Layer, LayerMap, RcMap } from "effect"
import type { Location } from "../../src/location"
import { LocationServiceMap } from "../../src/location-service-map"

export const fixedLocations = <A, E>(
  lookup: (ref: Location.Ref) => Layer.Layer<A, E>,
  options?: { readonly idleTimeToLive?: Duration.Input },
) =>
  Effect.gen(function* () {
    const map = yield* LayerMap.make(lookup, options)
    return LocationServiceMap.Service.of({
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      get: (ref) => map.get(ref) as never,
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      contextEffect: (ref) => map.contextEffect(ref) as never,
      invalidate: map.invalidate,
      loaded: () => Effect.map(RcMap.keys(map.rcMap), (keys) => Array.from(keys, (ref) => ({ ref, built: [] }))),
    })
  })
