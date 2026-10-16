import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { statics } from "./schema.js"

export const SessionReviewID = Schema.String.check(Schema.isStartsWith("rvw_")).pipe(
  Schema.brand("SessionReview.ID"),
  Schema.annotate({ identifier: "SessionReview.ID" }),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "rvw_" + ascending()) })),
)
export type SessionReviewID = typeof SessionReviewID.Type
