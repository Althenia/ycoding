import { McpEvents } from "@ycoding-ai/schema/mcp-events"
export { McpEvents } from "@ycoding-ai/schema/mcp-events"
import { Schema } from "effect"

export const SubscribeRequest = Schema.Struct({
  context: McpEvents.RequestContext,
  subscription: McpEvents.Subscribe,
})

export const UnsubscribeRequest = Schema.Struct({
  context: McpEvents.RequestContext,
  subscription: McpEvents.Unsubscribe,
})

export const ListQuery = Schema.Struct({ cursor: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))) })
