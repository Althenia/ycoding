import { Model } from "@ycoding-ai/schema/model"
import { Location } from "@ycoding-ai/schema/location"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const makeModelGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  CatalogLocationId extends HttpApiMiddleware.AnyId,
  CatalogLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  catalogLocationMiddleware: Context.Key<CatalogLocationId, CatalogLocationService>,
) =>
  HttpApiGroup.make("server.model")
    .add(
      HttpApiEndpoint.get("model.list", "/api/model", {
        query: LocationQuery,
        success: Location.response(Schema.Array(Model.Info)),
        error: ServiceUnavailableError,
      })
        .middleware(catalogLocationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "model.list",
            summary: "List models",
            description: "Retrieve available models ordered by release date.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("model.default", "/api/model/default", {
        query: LocationQuery,
        success: Location.response(Schema.UndefinedOr(Model.Default)),
        error: ServiceUnavailableError,
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "model.default",
            summary: "Get default model",
            description: "Retrieve the model used when a session has no explicit model selection.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "model",
        description: "Experimental model routes.",
      }),
    )
