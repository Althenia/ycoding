export * as ConfigError from "./error"

import { Schema } from "effect"
import { NamedError } from "../util/error"

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

export const InvalidError = NamedError.create("ConfigInvalidError", {
  path: Schema.String,
  issues: Schema.optional(Schema.Array(Issue)),
  message: Schema.optional(Schema.String),
})
