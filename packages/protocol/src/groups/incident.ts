import { Agent } from "@ycoding-ai/schema/agent"
import { Model } from "@ycoding-ai/schema/model"
import { ModelIncident } from "@ycoding-ai/schema/model-incident"
import { Provider } from "@ycoding-ai/schema/provider"
import { NonNegativeInt, PositiveInt } from "@ycoding-ai/schema/schema"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const count = Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional)
const limit = (max: number) =>
  Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt.check(Schema.isLessThanOrEqualTo(max))), Schema.optional)

export const IncidentReportQuery = Schema.Struct({
  group: ModelIncident.Group,
  from: count,
  to: count,
  offset: count,
  limit: limit(200),
}).annotate({ identifier: "ModelIncidentReportQuery" })

export const IncidentRecentQuery = Schema.Struct({
  provider: Provider.ID,
  model: Model.ID,
  agent: Agent.ID.pipe(Schema.optional),
  limit: limit(50),
}).annotate({ identifier: "ModelIncidentRecentQuery" })

export const IncidentGuidanceQuery = Schema.Struct({
  provider: Provider.ID,
  model: Model.ID,
  ...LocationQuery.fields,
}).annotate({ identifier: "ModelIncidentGuidanceQuery" })

export const makeIncidentGroup = <LocationId extends HttpApiMiddleware.AnyId, LocationService>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
) =>
  HttpApiGroup.make("server.incident")
    .add(
      HttpApiEndpoint.get("incident.report", "/api/incident/report", {
        query: IncidentReportQuery,
        success: Schema.Struct({ data: ModelIncident.Report }),
        error: [InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "incident.report",
          summary: "Report model incidents",
          description:
            "Count retained model incidents grouped by model or by model and agent before bounded pagination.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("incident.recent", "/api/incident/recent", {
        query: IncidentRecentQuery,
        success: Schema.Struct({ data: ModelIncident.Recent }),
        error: [InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "incident.recent",
          summary: "List recent model incidents",
          description: "List the newest retained incidents for one model, optionally narrowed to an agent.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("incident.guidance.get", "/api/incident/guidance", {
        query: IncidentGuidanceQuery,
        success: Schema.Struct({ data: ModelIncident.Guidance }),
        error: [InvalidRequestError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "incident.guidance.get",
            summary: "Read model incident guidance",
            description: "Read the fixed guidance state for one model.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("incident.guidance.clear", "/api/incident/guidance", {
        query: IncidentGuidanceQuery,
        success: Schema.Struct({ data: ModelIncident.Guidance }),
        error: [InvalidRequestError],
      })
        .middleware(locationMiddleware)
        .annotateMerge(locationQueryOpenApi)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "incident.guidance.clear",
            summary: "Clear model incident guidance",
            description: "Clear the guidance text for one model and return the resulting guidance state.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "incident",
        description: "Local-runtime model incident routes.",
      }),
    )
