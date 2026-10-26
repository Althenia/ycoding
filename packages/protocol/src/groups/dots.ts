import { Dots } from "@ycoding-ai/schema/dots"
import { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { Session } from "@ycoding-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "../errors.js"

export function makeDotsGroup<Id extends HttpApiMiddleware.AnyId, Service>(middleware: Context.Key<Id, Service>) {
  return HttpApiGroup.make("server.dots")
    .add(
      HttpApiEndpoint.post("session.dots.exchange.create", "/api/session/:sessionID/dots/exchanges", {
        params: { sessionID: Session.ID },
        payload: Schema.Union([
          Schema.Struct({ ...Dots.ExchangeCreate.members[0].fields, remoteSource: McpEvents.RequestContext }),
          Schema.Struct({ ...Dots.ExchangeCreate.members[1].fields, remoteSource: McpEvents.RequestContext }).annotate({ parseOptions: { onExcessProperty: "error" } }),
          Schema.Struct({ ...Dots.ExchangeCreate.members[2].fields, remoteSource: McpEvents.RequestContext }).annotate({ parseOptions: { onExcessProperty: "error" } }),
        ]),
        success: Schema.Struct({ data: Dots.Exchange }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "session.dots.exchange.create", summary: "Admit an authenticated external task to an authorized Session" })),
    )
    .add(
      HttpApiEndpoint.post("session.dots.delegation.status", "/api/session/:sessionID/dots/delegation/status", {
        params: { sessionID: Session.ID }, payload: Dots.DelegationStatusInput,
        success: Schema.Struct({ data: Dots.DelegationStatus }), error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "session.dots.delegation.status", summary: "Read native task delegation candidates and grants" })),
    )
    .add(
      HttpApiEndpoint.post("session.dots.delegation.create", "/api/session/:sessionID/dots/delegation", {
        params: { sessionID: Session.ID }, payload: Dots.DelegationCreate,
        success: Schema.Struct({ data: Dots.DelegationInfo }), error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "session.dots.delegation.create", summary: "Ask a native human to activate a bounded task delegation" })),
    )
    .add(
      HttpApiEndpoint.post("session.dots.delegation.revoke", "/api/session/:sessionID/dots/delegation/revoke", {
        params: { sessionID: Session.ID }, payload: Dots.DelegationRevoke,
        success: Schema.Struct({ data: Dots.DelegationInfo }), error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "session.dots.delegation.revoke", summary: "Revoke a task delegation for future admissions" })),
    )
    .add(
      HttpApiEndpoint.post("session.dots.exchange.read", "/api/session/:sessionID/dots/exchanges/read", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ ...Dots.ExchangeRead.fields, remoteSource: McpEvents.RequestContext }),
        success: Schema.Struct({ data: Dots.Exchange }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(OpenApi.annotations({ identifier: "session.dots.exchange.read", summary: "Read the correlated progress and result of an authenticated exchange" })),
    )
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
    .add(
      HttpApiEndpoint.post("session.dots.unbind", "/api/session/:sessionID/dots/unbind", {
        params: { sessionID: Session.ID },
        payload: Dots.Control,
        success: Schema.Struct({ data: Dots.Status }),
        error: [InvalidRequestError, SessionNotFoundError],
      }).annotateMerge(
        OpenApi.annotations({ identifier: "session.dots.unbind", summary: "Remove the Session's local Dots binding without remote changes" }),
      ),
    )
    .middleware(middleware)
}
