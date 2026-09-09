export * as PtyTicket from "./pty-ticket.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "./schema.js"
import { Pty } from "./pty.js"

export const ConnectToken = Schema.Struct({
  ticket: Schema.String,
  expires_in: PositiveInt,
  access: Pty.Access,
  generation: Pty.Generation,
  fence: PositiveInt.pipe(optional),
}).annotate({ identifier: "PtyTicket.ConnectToken" })
export interface ConnectToken extends Schema.Schema.Type<typeof ConnectToken> {}
