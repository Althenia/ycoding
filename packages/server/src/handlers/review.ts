import { SessionReview } from "@ycoding-ai/core/session/review"
import {
  ConflictError,
  InvalidRequestError,
  ReviewItemNotFoundError,
  SessionNotFoundError,
} from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

const sessionNotFound = (error: { readonly sessionID: string }) =>
  new SessionNotFoundError({
    sessionID: error.sessionID,
    message: `Session not found: ${error.sessionID}`,
  })

export const ReviewHandler = HttpApiBuilder.group(Api, "server.review", (handlers) =>
  Effect.gen(function* () {
    const review = yield* SessionReview.Service
    return handlers
      .handle(
        "session.review.list",
        Effect.fn(function* (ctx) {
          return {
            data: yield* review
              .list(ctx.params.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", sessionNotFound)),
          }
        }),
      )
      .handle(
        "session.review.decide",
        Effect.fn(function* (ctx) {
          yield* review
            .decide({
              sessionID: ctx.params.sessionID,
              itemID: ctx.params.itemID,
              decision: ctx.payload.decision,
            })
            .pipe(
              Effect.catchTags({
                "Session.NotFoundError": sessionNotFound,
                "SessionReview.NotFoundError": () =>
                  new ReviewItemNotFoundError({
                    itemID: ctx.params.itemID,
                    message: `Review item not found: ${ctx.params.itemID}`,
                  }),
                "SessionReview.InvalidDecisionError": (error) =>
                  new InvalidRequestError({ message: error.message }),
                "SessionReview.ConflictError": (error) => new ConflictError({ message: error.message }),
              }),
            )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
