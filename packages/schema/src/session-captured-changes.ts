export * as SessionCapturedChanges from "./session-captured-changes.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionMessage } from "./session-message.js"

export const Input = Schema.Struct({
  id: SessionMessage.ID,
  type: Schema.Literals(["user", "synthetic", "assistant"]),
  metadata: Schema.Struct({ kind: Schema.String.pipe(optional), questionID: Schema.String.pipe(optional) }).pipe(optional),
  content: Schema.Array(Schema.Struct({
    type: Schema.Literal("tool"),
    id: Schema.String.pipe(optional),
    name: Schema.String,
    state: Schema.Struct({
      status: Schema.String.pipe(optional),
      input: Schema.Struct({ questionID: Schema.String.pipe(optional) }).pipe(optional),
      structured: Schema.Struct({
        files: Schema.Array(Schema.Struct({ file: Schema.String.pipe(optional), patch: Schema.String, status: Schema.String.pipe(optional) })).pipe(optional),
        sessionID: Schema.String.pipe(optional),
        action: Schema.String.pipe(optional),
        task: Schema.Struct({ sessionID: Schema.String.pipe(optional) }).pipe(optional),
      }).pipe(optional),
    }),
  })).pipe(optional),
}).annotate({ identifier: "SessionCapturedChanges.Input" })
export type Input = typeof Input.Type

export const Page = Schema.Struct({
  data: Schema.Array(Input),
  next: NonNegativeInt.pipe(optional),
}).annotate({ identifier: "SessionCapturedChanges.Page" })
export type Page = typeof Page.Type
