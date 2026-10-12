import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SessionCapturedChanges } from "@ycoding-ai/core/session/captured-changes"
import { Database } from "@ycoding-ai/core/database/database"
import { Effect, Schema, Stream } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { SessionNotFoundError, UnknownError } from "@ycoding-ai/protocol/errors"
import { Api } from "../api"

const encode = Schema.encodeSync(Schema.toCodecJson(SessionMessage.Info))
const encoder = new TextEncoder()
const prefix = '{"data":['
const suffix = "]}"

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers.handle("session.capturedInputs", Effect.fn(function* (ctx) {
      const database = yield* Database.Service
      return yield* SessionCapturedChanges.page(database.db, { sessionID: ctx.params.sessionID, after: ctx.query.after, limit: ctx.query.limit ?? 200 }).pipe(
        Effect.catchTag("Session.NotFoundError", (error) => Effect.fail(new SessionNotFoundError({ sessionID: error.sessionID, message: `Session not found: ${error.sessionID}` }))),
        Effect.catchTag("Session.MessageDecodeError", (error) => {
          const ref = `err_${crypto.randomUUID().slice(0, 8)}`
          return Effect.logError("failed to decode captured change input").pipe(
            Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
            Effect.andThen(Effect.fail(new UnknownError({ message: "Unexpected server error. Check server logs for details.", ref }))),
          )
        }),
      )
    })).handle(
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
        return messageResponse(messages)
      }),
    )
  }),
)

function messageResponse(messages: ReadonlyArray<SessionMessage.Info>) {
  const serialized = messages.map((message) => JSON.stringify(encode(message)))
  return HttpServerResponse.stream(
    Stream.concat(
      Stream.make(encoder.encode(prefix)),
      Stream.fromIterable(serialized, { chunkSize: 1 }).pipe(
        Stream.map((message, index) => encoder.encode((index === 0 ? "" : ",") + message)),
      ),
    ).pipe(Stream.concat(Stream.make(encoder.encode(suffix)))),
    {
      contentType: "application/json",
      contentLength: prefix.length + suffix.length + Math.max(0, serialized.length - 1)
        + serialized.reduce((size, message) => size + Buffer.byteLength(message), 0),
    },
  )
}
