export * as SessionWorkCompletion from "./session-work-completion.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

export interface Receipt extends Schema.Schema.Type<typeof Receipt> {}
export const Receipt = Schema.Struct({
  id: Event.ID,
  seq: Event.Seq,
  created: NonNegativeInt,
  sessionID: SessionID,
  inputID: SessionMessage.ID,
  assistantMessageID: SessionMessage.ID,
}).annotate({ identifier: "SessionWorkCompletion.Receipt" })

export interface Page extends Schema.Schema.Type<typeof Page> {}
export const Page = Schema.Struct({
  data: Schema.Array(Receipt),
  next: SessionID.pipe(optional),
}).annotate({ identifier: "SessionWorkCompletion.Page" })
