import { Schema } from "effect"
import { Telemetry } from "@ycoding-ai/schema/telemetry"
import { PositiveInt } from "@ycoding-ai/schema/schema"
import { InvalidCursorError, InvalidRequestError } from "../errors.js"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const ServerGroup = HttpApiGroup.make("server.server")
  .add(
    HttpApiEndpoint.get("server.get", "/api/server", {
      success: Schema.Struct({ urls: Schema.Array(Schema.String) }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "server.get",
        summary: "Get server information",
        description: "Return the URLs that can be used to connect to this server.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("telemetry.append", "/api/server/web-latency", {
      payload: Telemetry.Batch,
      success: Schema.Struct({ accepted: Schema.Int }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "telemetry.append",
        summary: "Record machine-local Web latency samples",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("telemetry.list", "/api/server/web-latency", {
      query: Schema.Struct({
        limit: Schema.NumberFromString.pipe(
          Schema.decodeTo(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
          Schema.optional,
        ),
        before: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(Schema.optional),
      }).annotate({ parseOptions: { onExcessProperty: "error" } }),
      success: Telemetry.Page,
      error: InvalidCursorError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "telemetry.list",
        summary: "Read recent machine-local Web latency samples",
      }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "server" }))
