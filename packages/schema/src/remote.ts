export * as Remote from "./remote.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema.js"

export const State = Schema.Literals(["off", "connecting", "on", "error"])
export type State = typeof State.Type

export const Status = Schema.Struct({
  state: State,
  message: Schema.optional(Schema.String),
})
export type Status = typeof Status.Type

export interface McpClientCapabilities extends Schema.Schema.Type<typeof McpClientCapabilities> {}
export const McpClientCapabilities = Schema.Struct({
  protocolVersion: Schema.String.check(Schema.isMaxLength(64)).pipe(optional),
  elicitation: Schema.Boolean.pipe(optional),
  form: Schema.Boolean.pipe(optional),
  url: Schema.Boolean.pipe(optional),
  observedAt: NonNegativeInt,
})

export const McpStatus = Schema.Struct({
  state: State,
  message: Schema.String.pipe(optional),
  url: Schema.String.pipe(optional),
  clientCapabilities: Schema.Array(McpClientCapabilities).check(Schema.isMaxLength(256)).pipe(optional),
})
export type McpStatus = typeof McpStatus.Type
