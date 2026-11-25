import { Coordination } from "@ycoding-ai/schema/coordination"
import { Session } from "@ycoding-ai/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

export class CoordinationError extends Schema.TaggedErrorClass<CoordinationError>()("CoordinationError", {
  reason: Schema.String,
  message: Schema.String,
}) {}

const root = "/api/coordination"
const params = { groupID: Coordination.GroupID }
const memberParams = { ...params, sessionID: Session.ID }
const failure = CoordinationError.annotate({ httpApiStatus: 409 })

export const CoordinationGroup = HttpApiGroup.make("server.coordination")
  .add(HttpApiEndpoint.get("coordination.settings", `${root}/settings`, { success: Schema.Struct({ data: Coordination.Settings }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.settings" })))
  .add(HttpApiEndpoint.get("coordination.list", root, { success: Schema.Struct({ data: Schema.Array(Coordination.GroupSummary) }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.list" })))
  .add(HttpApiEndpoint.post("coordination.create", root, { payload: Coordination.CreateInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.create" })))
  .add(HttpApiEndpoint.get("coordination.get", `${root}/:groupID`, { params, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.get" })))
  .add(HttpApiEndpoint.patch("coordination.update", `${root}/:groupID`, { params, payload: Coordination.UpdateInput, success: Schema.Struct({ data: Coordination.Info }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.update" })))
  .add(HttpApiEndpoint.delete("coordination.delete", `${root}/:groupID`, { params, success: HttpApiSchema.NoContent, error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.delete" })))
  .add(HttpApiEndpoint.post("coordination.attach", `${root}/:groupID/members`, { params, payload: Coordination.AttachInput, success: Schema.Struct({ data: Coordination.AttachResult }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.attach" })))
  .add(HttpApiEndpoint.delete("coordination.detach", `${root}/:groupID/members/:sessionID`, { params: memberParams, success: Schema.Struct({ data: Schema.Struct({ sessionID: Session.ID, removed: Schema.Literal(true) }) }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.detach" })))
  .add(HttpApiEndpoint.get("coordination.board", `${root}/:groupID/board`, { params, success: Schema.Struct({ data: Coordination.Board }), error: failure }).annotateMerge(OpenApi.annotations({ identifier: "coordination.board" })))
  .annotateMerge(OpenApi.annotations({ title: "coordination", description: "Owner-authenticated local Projects: one Master Session and its member Sessions; Session Locations are resolved by the backend." }))
