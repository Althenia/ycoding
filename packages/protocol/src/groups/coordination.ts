import { Coordination } from "@ycoding-ai/schema/coordination"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export class CoordinationError extends Schema.TaggedErrorClass<CoordinationError>()("CoordinationError", {
  reason: Schema.String,
  message: Schema.String,
}) {}

const root = "/api/coordination"
const params = { groupID: Coordination.GroupID }
const failure = CoordinationError.annotate({ httpApiStatus: 409 })

export const CoordinationGroup = HttpApiGroup.make("server.coordination")
  .add(HttpApiEndpoint.get("coordination.settings", `${root}/settings`, { success: Schema.Struct({ data: Coordination.Settings }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.settings" })))
  .add(HttpApiEndpoint.get("coordination.list", root, { success: Schema.Struct({ data: Schema.Array(Coordination.GroupSummary) }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.list" })))
  .add(HttpApiEndpoint.post("coordination.create", root, { payload: Coordination.CreateInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.create" })))
  .add(HttpApiEndpoint.get("coordination.get", `${root}/:groupID`, { params, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.get" })))
  .add(HttpApiEndpoint.patch("coordination.update", `${root}/:groupID`, { params, payload: Coordination.UpdateInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.update" })))
  .add(HttpApiEndpoint.delete("coordination.delete", `${root}/:groupID`, { params, success: HttpApiSchema.NoContent, error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.delete" })))
  .annotateMerge(OpenApi.annotations({ title: "coordination", description: "Owner-authenticated local Projects: one Master Session and its member Sessions; Session Locations are resolved by the backend." }))
