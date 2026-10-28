import { Location } from "@ycoding-ai/core/location"
import type { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { LocationServiceMap } from "@ycoding-ai/core/location-services"
import type { LocationServices } from "@ycoding-ai/core/location-services"
import { CatalogContributions } from "@ycoding-ai/core/plugin/catalog-contributions"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Workspace } from "@ycoding-ai/core/workspace"
import { Effect, Layer } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"

export type { LocationServices }

export const catalogNodes = [Location.node, ...CatalogContributions.nodes] as const

export type CatalogLocationServices = LayerNode.Output<(typeof catalogNodes)[number]>

export class CatalogLocationMiddleware extends HttpApiMiddleware.Service<
  CatalogLocationMiddleware,
  { provides: CatalogLocationServices }
>()("@ycoding/HttpApiCatalogLocation") {}

export class LocationMiddleware extends HttpApiMiddleware.Service<LocationMiddleware, { provides: LocationServices }>()(
  "@ycoding/HttpApiLocation",
) {}

export function response<A, E, R>(data: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const location = yield* Location.Service
    return {
      location: new Location.Info({
        directory: location.directory,
        workspaceID: location.workspaceID,
        project: location.project,
      }),
      data: yield* data,
    }
  })
}

export function requestRef(request: HttpServerRequest.HttpServerRequest): Location.Ref {
  const query = new URL(request.url, "http://localhost").searchParams
  const workspaceID = query.get("location[workspace]") || request.headers["x-ycoding-workspace"]
  const directory =
    query.get("location[directory]") ||
    (request.headers["x-ycoding-directory"] ? decode(request.headers["x-ycoding-directory"]) : process.cwd())
  return Location.Ref.make({
    directory: AbsolutePath.make(directory),
    workspaceID: workspaceID ? Workspace.ID.make(workspaceID) : undefined,
  })
}

function decode(input: string) {
  try {
    return decodeURIComponent(input)
  } catch {
    return input
  }
}

export const layer = Layer.effect(
  LocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return LocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* effect.pipe(Effect.provide(locations.get(requestRef(request), [LocationServiceMap.full])))
      }),
    )
  }),
)

export const catalogLayer = Layer.effect(
  CatalogLocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    return CatalogLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* effect.pipe(Effect.provide(locations.get(requestRef(request), catalogNodes)))
      }),
    )
  }),
)
