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
            identifier: "v2.session.guardrail.status",
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
            identifier: "v2.session.guardrail.request.list",
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
            identifier: "v2.session.guardrail.request.reply",
            summary: "Reply to Session guardrail review",
            description:
              "Approve once, grant Always approval for exact matching asks and metadata in this root Session family and current Location process, or reject. Always approval is neither durable nor global.",
          }),
        ),
    )
    .annotateMerge(OpenApi.annotations({ title: "guardrail", description: "Session-wide guardrail routes." }))
