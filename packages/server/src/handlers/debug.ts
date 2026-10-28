import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requestRef } from "../location"

export const DebugHandler = HttpApiBuilder.group(Api, "server.debug", (handlers) =>
  handlers
    .handle(
      "debug.location",
      Effect.fn(function* () {
        const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
        return (yield* locations.loaded()).map((entry) => entry.ref)
      }),
    )
    .handle(
      "debug.location.evict",
      Effect.fn(function* (ctx) {
        const locations = Option.getOrThrow(yield* Effect.serviceOption(LocationServiceMap.Service))
        // Resolve through requestRef so the key matches the shape the location
        // middleware cached the services under.
        yield* locations.invalidate(requestRef(ctx.request))
      }),
    ),
)
