export * as KeepAwake from "./keep-awake.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const State = Schema.Literals(["off", "on", "unsupported", "error"]).annotate({ identifier: "KeepAwake.State" })
export type State = typeof State.Type

export const maxMessageLength = 200

export const Status = Schema.Struct({
  state: State,
  message: Schema.String.check(Schema.isMaxLength(maxMessageLength)).pipe(optional),
}).annotate({ identifier: "KeepAwake.Status" })
export type Status = typeof Status.Type
