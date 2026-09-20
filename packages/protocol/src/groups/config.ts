import { Config } from "@ycoding-ai/schema/config"
import { Location } from "@ycoding-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConfigInvalidError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const ConfigGroup = HttpApiGroup.make("server.config")
  .add(
    HttpApiEndpoint.get("config.get", "/api/config", {
      query: LocationQuery,
      success: Location.response(Config.Read),
      error: ConfigInvalidError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.get",
          summary: "Read effective configuration",
          description:
            "Return effective configuration values for the Location with per-document provenance and secret-bearing values redacted.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("config.preview", "/api/config/preview", {
      query: LocationQuery,
      payload: Config.Patch,
      success: Location.response(Config.Preview),
      error: ConfigInvalidError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.preview",
          summary: "Preview a configuration patch",
          description:
            "Validate a patch against the configuration schema and report the resulting changes and revision without writing.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.put("config.commit", "/api/config", {
      query: LocationQuery,
      payload: Config.Patch,
      success: Location.response(Config.Commit),
      error: ConfigInvalidError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.config.commit",
          summary: "Commit a configuration patch",
          description:
            "Write a validated patch to the Location's global or project configuration document, preserving comments, formatting, unknown fields, and substitution tokens, then return the settled readback.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "config", description: "Location configuration read and write routes." }))

export type ConfigEndpoint = (typeof ConfigGroup)["endpoints"][keyof (typeof ConfigGroup)["endpoints"]]
export const ConfigResponse = Schema.Struct({ location: Location.Info, data: Config.Read })
