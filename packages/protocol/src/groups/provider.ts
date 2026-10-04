import { Provider } from "@ycoding-ai/schema/provider"
import { Location } from "@ycoding-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ProviderNotFoundError, ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const ProviderGroup = HttpApiGroup.make("server.provider")
  .add(
    HttpApiEndpoint.get("provider.list", "/api/provider", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Provider.Info)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "provider.list",
          summary: "List providers",
          description: "Retrieve active AI providers so clients can show provider availability and configuration.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("provider.refresh", "/api/provider/refresh", {
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "provider.refresh",
          summary: "Refresh providers and models",
          description:
            "Rediscover the location's configuration sources and rerun provider model discovery. Clients observe the refreshed catalog through catalog.updated.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("provider.get", "/api/provider/:providerID", {
      params: { providerID: Provider.ID },
      query: LocationQuery,
      success: Location.response(Provider.Info),
      error: [ProviderNotFoundError, ServiceUnavailableError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "provider.get",
          summary: "Get provider",
          description: "Retrieve a single AI provider so clients can inspect its availability and endpoint settings.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "provider",
      description: "Experimental provider routes.",
    }),
  )
