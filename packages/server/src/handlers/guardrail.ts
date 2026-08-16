import { SessionGuardrail } from "@ycoding-ai/core/session/guardrail"
import { GuardrailRequestNotFoundError, SessionNotFoundError } from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

const sessionNotFound = (error: { readonly sessionID: string }) =>
  new SessionNotFoundError({
    sessionID: error.sessionID,
    message: `Session not found: ${error.sessionID}`,
  })

const requestNotFound = (requestID: SessionGuardrail.ReplyInput["requestID"]) =>
  new GuardrailRequestNotFoundError({
    requestID,
    message: `Guardrail request not found: ${requestID}`,
  })

export const guardrailStatus = (
  service: SessionGuardrail.Interface,
  sessionID: SessionGuardrail.EvaluateInput["sessionID"],
) => service.status(sessionID).pipe(Effect.catchTag("Session.NotFoundError", sessionNotFound))

export const guardrailRequests = (
  service: SessionGuardrail.Interface,
  sessionID: SessionGuardrail.EvaluateInput["sessionID"],
) => service.forSession(sessionID).pipe(Effect.catchTag("Session.NotFoundError", sessionNotFound))

export const replyGuardrail = (service: SessionGuardrail.Interface, input: SessionGuardrail.ReplyInput) =>
  service.reply(input).pipe(
    Effect.catchTags({
      "Session.NotFoundError": sessionNotFound,
      "Guardrail.RequestNotFoundError": () => requestNotFound(input.requestID),
    }),
  )

export const GuardrailHandler = HttpApiBuilder.group(Api, "server.guardrail", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "session.guardrail.status",
        Effect.fn(function* (ctx) {
          const guardrail = yield* SessionGuardrail.Service
          return { data: yield* guardrailStatus(guardrail, ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.guardrail.request.list",
        Effect.fn(function* (ctx) {
          const guardrail = yield* SessionGuardrail.Service
          return { data: yield* guardrailRequests(guardrail, ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.guardrail.request.reply",
        Effect.fn(function* (ctx) {
          const guardrail = yield* SessionGuardrail.Service
          yield* replyGuardrail(guardrail, {
            sessionID: ctx.params.sessionID,
            requestID: ctx.params.requestID,
            reply: ctx.payload.reply,
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
