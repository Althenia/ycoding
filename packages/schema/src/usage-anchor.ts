export * as UsageAnchor from "./usage-anchor.js"

import { Schema } from "effect"
import { SessionID } from "./session-id.js"
import { ID } from "./session-message-id.js"

export const Ref = Schema.Struct({ sessionID: SessionID, inputID: ID }).annotate({ identifier: "UsageAnchor.Ref" })
export interface Ref extends Schema.Schema.Type<typeof Ref> {}
