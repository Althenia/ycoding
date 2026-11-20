import { Interaction } from "@ycoding-ai/schema/interaction"
import { Session } from "@ycoding-ai/schema/session"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, ForbiddenError, SessionNotFoundError } from "../errors.js"

const session = { sessionID: Session.ID }
const path = "/api/session/:sessionID/interaction"
const errors = [SessionNotFoundError, ForbiddenError] as const

export const InteractionGroup = HttpApiGroup.make("server.interaction")
  .add(HttpApiEndpoint.get("session.interaction.status", path, {
    params: session, success: Schema.Struct({ data: Interaction.Status }), error: errors,
  }).annotateMerge(OpenApi.annotations({ identifier: "session.interaction.status", summary: "Read current Session Interaction status" })))
  .add(HttpApiEndpoint.post("session.interaction.request", path, {
    params: session, payload: Interaction.Request, success: Schema.Struct({ data: Interaction.Status }), error: errors,
  }).annotateMerge(OpenApi.annotations({ identifier: "session.interaction.request", summary: "Request native Interaction consent" })))
  .add(HttpApiEndpoint.get("session.interaction.preview", "/api/session/:sessionID/interaction/preview", {
    params: session, query: Interaction.Fence, success: Schema.Struct({ data: Interaction.Preview }), error: errors,
  }).annotateMerge(OpenApi.annotations({ identifier: "session.interaction.preview", summary: "Read the authorized Interaction preview" })))
  .add(HttpApiEndpoint.post("session.interaction.stop", "/api/session/:sessionID/interaction/stop", {
    params: session, payload: Interaction.Fence, success: Schema.Struct({ data: Interaction.Status }), error: [...errors, ConflictError],
  }).annotateMerge(OpenApi.annotations({ identifier: "session.interaction.stop", summary: "Revoke the exact Interaction generation" })))
