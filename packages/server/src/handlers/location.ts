import { Location } from "@ycoding-ai/core/location"
import { LocationServiceMap } from "@ycoding-ai/core/location-service-map"
import { Project } from "@ycoding-ai/core/project"
import { Effect } from "effect"
import { HttpServerRequest } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requestRef } from "../location"

export const LocationHandler = HttpApiBuilder.group(Api, "server.location", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const project = yield* Project.Service
    return handlers.handle(
      "location.get",
      Effect.fn(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* Effect.gen(function* () {
          const location = yield* Location.Service
          yield* project.recordOpened(location.directory)
          return new Location.Info({
            directory: location.directory,
            workspaceID: location.workspaceID,
            project: location.project,
          })
        }).pipe(Effect.provide(locations.get(requestRef(request), [Location.node])))
      }),
    )
  }),
)
