import { Session } from "@ycoding-ai/schema/session"
import { SessionReview } from "@ycoding-ai/schema/session-review"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  InvalidRequestError,
  ReviewItemNotFoundError,
  SessionNotFoundError,
  UnknownError,
} from "../errors.js"

export const ReviewDecide = Schema.Struct({ decision: SessionReview.Decision }).annotate({
  identifier: "SessionReview.Decide",
})
export interface ReviewDecide extends Schema.Schema.Type<typeof ReviewDecide> {}

export const makeReviewGroup = <SessionLocationId extends HttpApiMiddleware.AnyId, SessionLocationService>(
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.review")
    .add(
      HttpApiEndpoint.get("session.review.list", "/api/session/:sessionID/review", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionReview.Item) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.review.list",
            summary: "List open family review items",
            description:
              "List open review items in deferral order for the addressed Session family, excluding archived Sessions, with owning Session and child attribution.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.review.decide", "/api/session/:sessionID/review/:itemID/decide", {
        params: { sessionID: Session.ID, itemID: SessionReview.ID },
        payload: ReviewDecide,
        success: HttpApiSchema.NoContent,
        error: [InvalidRequestError, SessionNotFoundError, ReviewItemNotFoundError, ConflictError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "session.review.decide",
            summary: "Decide a deferred review item",
            description:
              "Apply a human decision to an open item in this Session family without waking it. Hard guardrails reject Always with 400. Archived items and conflicting decisions return 409, including any repeat of a settled decision; the one exception is a stopped managed-child recovery item, which accepts a single later human continue. Approvals never replay an action.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({ title: "review", description: "Deferred human decisions for a Session family." }),
    )
