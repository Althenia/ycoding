import { Guardrail } from "@ycoding-ai/schema/guardrail"
import { Session } from "@ycoding-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { GuardrailRequestNotFoundError, SessionNotFoundError } from "../errors.js"

export const makeGuardrailGroup = <
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>) =>
  HttpApiGroup.make("server.guardrail")
    .add(
      HttpApiEndpoint.get("session.guardrail.status", "/api/session/:sessionID/guardrail", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Guardrail.Status }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.guardrail.status",
            summary: "Get Session guardrail status",
            description: "Retrieve the active root-Session guardrail profile, counters, and diagnostics.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.guardrail.request.list", "/api/session/:sessionID/guardrail/request", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Guardrail.Request) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.guardrail.request.list",
            summary: "List Session guardrail reviews",
            description: "Retrieve pending guardrail reviews for the Session root family.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post(
        "session.guardrail.request.reply",
        "/api/session/:sessionID/guardrail/request/:requestID/reply",
        {
          params: { sessionID: Session.ID, requestID: Guardrail.RequestID },
          payload: Schema.Struct({ reply: Guardrail.Reply }),
          success: HttpApiSchema.NoContent,
          error: [SessionNotFoundError, GuardrailRequestNotFoundError],
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.guardrail.request.reply",
            summary: "Reply to Session guardrail review",
            description:
              "Approve once, grant durable directory-scoped Always approval for an ordinary outside-repository review in this root family, or reject. Hard reviews allow only once or reject. Decision-model-owned reviews cannot receive human replies.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post(
        "session.guardrail.request.cancel",
        "/api/session/:sessionID/guardrail/request/:requestID/cancel",
        {
          params: { sessionID: Session.ID, requestID: Guardrail.RequestID },
          success: HttpApiSchema.NoContent,
          error: [SessionNotFoundError, GuardrailRequestNotFoundError],
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.guardrail.request.cancel",
            summary: "Cancel Session guardrail review",
            description:
              "Close a pending guardrail review without approving it. The waiting action fails and does not run, and a durable decision with reason cancelled is recorded. Unknown, settled, deferred, or other-family requests return not found.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post(
        "session.guardrail.request.retry",
        "/api/session/:sessionID/guardrail/request/:requestID/retry",
        {
          params: { sessionID: Session.ID, requestID: Guardrail.RequestID },
          success: Schema.Struct({ data: Guardrail.Request }),
          error: [SessionNotFoundError, GuardrailRequestNotFoundError],
        },
      )
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.guardrail.request.retry",
            summary: "Re-present Session guardrail review",
            description:
              "Retry re-presents the same pending review. It re-publishes guardrail.asked for the unchanged request (same id, same created) and returns it. It never approves, rejects or settles the review and never runs its command. The review stays pending until a reply, cancel or expiry. Unknown, settled, deferred, or other-family requests return not found.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "guardrail", description: "Session-wide guardrail routes." }))
