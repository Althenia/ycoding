import { Dots } from "@ycoding-ai/schema/dots"
import { Session } from "@ycoding-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, SessionNotFoundError } from "../errors.js"

export function makeDotsGroup<Id extends HttpApiMiddleware.AnyId, Service>(middleware: Context.Key<Id, Service>) {
  return HttpApiGroup.make("server.dots")
    .add(HttpApiEndpoint.get("session.dots.access.get", "/api/session/:sessionID/dots/access", {
      params: { sessionID: Session.ID }, success: Schema.Struct({ data: Dots.Access }),
      error: [InvalidRequestError, SessionNotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "session.dots.access.get", summary: "Read root-family Dots access" })))
    .add(HttpApiEndpoint.post("session.dots.access.set", "/api/session/:sessionID/dots/access", {
      params: { sessionID: Session.ID }, payload: Dots.AccessSet, success: Schema.Struct({ data: Dots.Access }),
      error: [ConflictError, InvalidRequestError, SessionNotFoundError],
    }).annotateMerge(OpenApi.annotations({ identifier: "session.dots.access.set", summary: "Change root Dots access at an exact revision" })))
    .middleware(middleware)
}
