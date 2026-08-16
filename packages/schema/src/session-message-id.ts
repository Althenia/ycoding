export * as SessionMessageID from "./session-message-id.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { ascending } from "./identifier.js"
import { statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartsWith("msg_")).pipe(
  Schema.brand("Session.Message.ID"),
  statics((schema) => ({
    create: () => schema.make("msg_" + ascending()),
    fromEvent: (eventID: Event.ID) => schema.make(eventID.replace(/^evt_/, "msg_")),
  })),
)
export type ID = typeof ID.Type
