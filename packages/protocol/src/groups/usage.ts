import { ProviderRequest } from "@ycoding-ai/schema/provider-request"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionUsageReportQuery } from "./session.js"

export const UsageGroup = HttpApiGroup.make("server.usage")
  .add(
    HttpApiEndpoint.get("usage.get", "/api/usage", {
      success: Schema.Struct({ data: ProviderRequest.Summary }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.usage.get",
        summary: "Get retained backend usage",
        description: "Aggregate retained provider-request usage across every Session in the local runtime.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("usage.report", "/api/usage/report", {
      query: SessionUsageReportQuery,
      success: Schema.Struct({ data: ProviderRequest.Report }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.usage.report",
        summary: "Report retained backend usage",
        description:
          "Group and sort retained provider-request usage across every Session in the local runtime before bounded pagination.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "usage",
      description: "Read-only local-runtime provider-request usage routes.",
    }),
  )
