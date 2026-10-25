import { Dots } from "@ycoding-ai/schema/dots"
import { Session } from "@ycoding-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "../errors.js"

export function makeDotsGroup<Id extends HttpApiMiddleware.AnyId, Service>(middleware: Context.Key<Id, Service>) {
  return HttpApiGroup.make("server.dots")
    .add(
      HttpApiEndpoint.get("session.dots.targets", "/api/session/:sessionID/dots/targets", {
        params: { sessionID: Session.ID },
        query: { profile: Schema.String },
        success: Schema.Struct({ data: Schema.Array(Dots.Target) }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.dots.targets",
          summary: "Read Dots destinations for an explicitly selected profile",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.dots.status", "/api/session/:sessionID/dots", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Dots.Status }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.dots.status",
          summary: "Read the Session's confirmed Dots destination",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.dots.bind", "/api/session/:sessionID/dots/bind", {
        params: { sessionID: Session.ID },
        payload: Dots.Target,
        success: Schema.Struct({ data: Dots.Status }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.dots.bind",
          summary: "Confirm a Dot and conversation without sending a message",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.dots.send", "/api/session/:sessionID/dots/send", {
        params: { sessionID: Session.ID },
        payload: Dots.Send,
        success: Schema.Struct({ data: Dots.Delivery }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "session.dots.send",
          summary: "Send an explicit payload to the Session's bound Dot",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.dots.pause", "/api/session/:sessionID/dots/pause", {
        params: { sessionID: Session.ID },
        payload: Dots.Control,
        success: Schema.Struct({ data: Dots.Status }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "session.dots.pause", summary: "Pause the Session's confirmed Dot runtime" }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.dots.resume", "/api/session/:sessionID/dots/resume", {
        params: { sessionID: Session.ID },
        payload: Dots.Control,
        success: Schema.Struct({ data: Dots.Status }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "session.dots.resume", summary: "Resume the Session's confirmed Dot runtime" }),
      ),
    )
    .middleware(middleware)
}
