import { SessionV2 } from "@ycoding-ai/core/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SessionNotFoundError, UnknownError } from "@ycoding-ai/protocol/errors"
import { Api } from "../api"

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

    return handlers.handle(
      "session.messages",
      Effect.fn(function* (ctx) {
        const messages = yield* session
          .messages({ sessionID: ctx.params.sessionID, order: "asc" })
          .pipe(
            Effect.catchTag("Session.NotFoundError", (error) =>
              Effect.fail(
                new SessionNotFoundError({
                  sessionID: error.sessionID,
                  message: `Session not found: ${error.sessionID}`,
                }),
              ),
            ),
            Effect.catchTag("Session.MessageDecodeError", (error) => {
              const ref = `err_${crypto.randomUUID().slice(0, 8)}`
              return Effect.logError("failed to decode session message").pipe(
                Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }),
                  ),
                ),
              )
            }),
          )
        return { data: messages }
      }),
    )
  }),
)
