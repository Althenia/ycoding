import { Config } from "@ycoding-ai/schema/config"
import { Location } from "@ycoding-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.diagnostics", "/api/config/diagnostics", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Config.Diagnostic)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "config.diagnostics",
          summary: "List configuration diagnostics",
          description: "Retrieve configuration documents ignored during discovery for this location.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Configuration diagnostic routes." }))
