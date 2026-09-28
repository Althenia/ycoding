export * as Remote from "./remote.js"

import { Schema } from "effect"

export const State = Schema.Literals(["off", "connecting", "on", "error"])
export type State = typeof State.Type

export const Status = Schema.Struct({
  state: State,
  message: Schema.optional(Schema.String),
})
export type Status = typeof Status.Type
