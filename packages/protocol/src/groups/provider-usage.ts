import { Location } from "@ycoding-ai/schema/location"
import { Provider } from "@ycoding-ai/schema/provider"
import { ProviderUsage } from "@ycoding-ai/schema/provider-usage"
import { Schema, SchemaGetter } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ServiceUnavailableError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

const Query = Schema.Struct({
  ...LocationQuery.fields,
  refresh: BooleanFromString.pipe(Schema.optional),
}).annotate({ identifier: "ProviderUsageQuery" })

export const ProviderUsageGroup = HttpApiGroup.make("server.providerUsage")
  .add(
    HttpApiEndpoint.get("providerUsage.list", "/api/provider/usage", {
      query: Query,
      success: Location.response(Schema.Array(ProviderUsage.Snapshot)),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.providerUsage.list",
          summary: "List provider usage",
          description: "Retrieve normalized quota and credit snapshots for configured providers.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("providerUsage.get", "/api/provider/:providerID/usage", {
      params: { providerID: Provider.ID },
      query: Query,
      success: Location.response(ProviderUsage.Snapshot),
      error: ServiceUnavailableError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.providerUsage.get",
          summary: "Get provider usage",
          description: "Retrieve one normalized provider quota snapshot.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "providerUsage",
      description: "Read-only provider quota and credit routes.",
    }),
  )
